/**
 * Stale-while-revalidate over the Workers Cache API.
 *
 * The rule this file exists to keep: a request never waits on work that has
 * already been done once. Past the TTL the cached bytes are served AS THEY ARE
 * and the refresh runs behind the response on ctx.waitUntil. Only a cold cache
 * blocks, because there is nothing else to serve.
 *
 * Freshness is decided here rather than by Cache-Control on the stored entry,
 * because the Cache API evicts an expired entry instead of handing it back --
 * which is exactly the stale copy this needs. So entries are stored effectively
 * immortal and stamped with STAMP; age is arithmetic we do.
 *
 * It caches WORK, not just fetches. An upstream document and the 27 MB SQLite
 * database built from four of them go through the same path, which is what makes
 * "the sources are cached and served stale, and the result is cached too" one
 * rule rather than two implementations of one idea.
 *
 * Cached bytes live in the Cache API, which is not the isolate's 128 MB heap. A
 * body becomes a JS value only when a caller asks for one, and a background
 * refresh of a fetched document never asks: it pipes the upstream response
 * straight into the store.
 */

/** The header carrying when the bytes were produced. Ours, not the upstream's. */
const STAMP = "x-modelinfo-fetched-at";

/** Long enough that the Cache API never expires an entry out from under the SWR window. */
const STORE_SECONDS = 30 * 24 * 60 * 60;

/** The slice of the Cache API this uses, so a test can supply a Map. */
export interface SWRStore {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
}

export interface SWROptions {
	ttlSeconds: number;
	/** Where a background refresh is registered. */
	waitUntil(promise: Promise<unknown>): void;
	/** Injectable for tests; defaults to caches.default. */
	store?: SWRStore;
	now?: () => Date;
	/**
	 * Wait for a stale entry to refresh instead of serving the stale copy.
	 *
	 * Only ever set off the request path. The database is rebuilt in the
	 * background, and a rebuild that accepted stale sources would carry an
	 * upstream change no further than the hour it was already behind: the sources
	 * would refresh AFTER the rebuild had read them, so the new data would not
	 * appear until the next rebuild, an hour later again. Nobody is waiting on a
	 * background rebuild, so it waits.
	 */
	blockUntilFresh?: boolean;
}

export interface Cached {
	/** The stored bytes. Read them once. */
	response: Response;
	/** When they were produced. */
	fetchedAt: Date;
	/** Seconds old. */
	ageSeconds: number;
	/** True when past the TTL: these bytes were served while a refresh runs behind. */
	stale: boolean;
	/** True when nothing was cached and this request paid for the work. */
	cold: boolean;
}

/**
 * swr returns the cached bytes for `key`, producing them if there are none.
 *
 * `produce` must return a fresh Response each time it is called; its body is
 * consumed by the store.
 */
export async function swr(
	key: string,
	produce: (background: boolean) => Promise<Response>,
	opts: SWROptions,
): Promise<Cached> {
	const now = opts.now ?? (() => new Date());
	const store = opts.store ?? defaultStore();

	const hit = await store.match(key);
	if (hit) {
		const stampedAt = hit.headers.get(STAMP);
		const fetchedAt = stampedAt ? new Date(stampedAt) : new Date(0);
		const ageSeconds = Math.max(0, Math.round((now().getTime() - fetchedAt.getTime()) / 1000));
		if (ageSeconds >= opts.ttlSeconds) {
			const refresh = once(key, () => replace(key, store, produce, now, true));
			if (opts.blockUntilFresh) {
				await refresh;
				return { response: await read(store, key), ...produced(now), cold: false };
			}
			// Behind the response, never in front of it. A failure here is
			// swallowed on purpose: the caller already has bytes, and the next
			// request sees the same staleness and tries again.
			opts.waitUntil(refresh.catch(() => undefined));
			return { response: hit, fetchedAt, ageSeconds, stale: true, cold: false };
		}
		return { response: hit, fetchedAt, ageSeconds, stale: false, cold: false };
	}

	await once(key, () => replace(key, store, produce, now, false));
	return { response: await read(store, key), ...produced(now), cold: true };
}

function produced(now: () => Date): { fetchedAt: Date; ageSeconds: number; stale: boolean } {
	return { fetchedAt: now(), ageSeconds: 0, stale: false };
}

/** replace produces the bytes and stores them. It does not hand them back. */
async function replace(
	key: string,
	store: SWRStore,
	produce: (background: boolean) => Promise<Response>,
	now: () => Date,
	background: boolean,
): Promise<void> {
	await store.put(key, stamp(await produce(background), now));
}

/**
 * read takes the bytes back OUT of the store rather than teeing them on the way
 * in, so every caller of one deduplicated production gets its own readable body.
 * A tee hands one body to whoever asked first and leaves everyone else holding a
 * response that is already spent.
 *
 * A store that accepted bytes and then does not have them is reported, not
 * worked around: it means the cache declined an entry this service is built on.
 */
async function read(store: SWRStore, key: string): Promise<Response> {
	const stored = await store.match(key);
	if (!stored) throw new Error(`the cache accepted ${key} and then did not have it`);
	return stored;
}

export interface FetchOptions extends SWROptions {
	/** Injectable for tests; defaults to global fetch. */
	fetcher?: typeof fetch;
}

export interface CachedBody extends Omit<Cached, "response"> {
	/** The upstream bytes. */
	body: string;
}

/** swrFetch is swr over an upstream document, handed back as text to parse. */
export async function swrFetch(url: string, opts: FetchOptions): Promise<CachedBody> {
	const doFetch = opts.fetcher ?? fetch;
	const { response, ...rest } = await swr(url, () => upstream(url, doFetch), opts);
	return { ...rest, body: await response.text() };
}

/**
 * inFlight collapses concurrent refreshes of one key into one.
 *
 * Without it every request arriving in the stale window starts its own refresh,
 * so the moment an hour elapses the upstream takes a burst instead of a request
 * -- and for the database key, one isolate would run several 2-second ingests at
 * once. It is per-isolate, which is all a Worker can offer and all this needs:
 * the burst it prevents is the one from a single isolate's own traffic.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Only for tests, which need each case to start from a cold isolate. */
export function forgetInFlight(): void {
	inFlight.clear();
}

function once<T>(key: string, work: () => Promise<T>): Promise<T> {
	const running = inFlight.get(key) as Promise<T> | undefined;
	if (running) return running;
	const started = work().finally(() => inFlight.delete(key));
	inFlight.set(key, started);
	return started;
}

/**
 * upstream fetches a document and refuses an empty one.
 *
 * The body is read here rather than piped into the store, which holds a second
 * copy of an 18 MB document for as long as this function runs. That copy buys
 * the one thing piping cannot: a blank 200 never reaches the cache, where it
 * would be the answer for an hour and fail every parse behind it.
 */
async function upstream(url: string, doFetch: typeof fetch): Promise<Response> {
	const res = await doFetch(url, {
		headers: {
			accept: "application/json",
			"user-agent": "modelinfo (+https://github.com/wow-look-at-my/modelinfo)",
		},
	});
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	const body = await res.text();
	if (!body.trim()) throw new Error(`${url} answered ${res.status} with an empty body`);
	return new Response(body, { headers: { "content-type": "application/json" } });
}

function stamp(res: Response, now: () => Date): Response {
	if (!res.body) throw new Error("nothing to cache: the response has no body");
	const headers = new Headers(res.headers);
	headers.set("cache-control", `public, max-age=${STORE_SECONDS}`);
	headers.set(STAMP, now().toISOString());
	return new Response(res.body, { headers });
}

function defaultStore(): SWRStore {
	const cache = caches.default;
	return {
		match: (key) => cache.match(key),
		put: (key, response) => cache.put(key, response),
	};
}

/** A Map-backed store, for tests and for a build with no Cache API around. */
export function memoryStore(): SWRStore {
	const held = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
	return {
		async match(key) {
			const e = held.get(key);
			return e ? new Response(e.body, { headers: e.headers }) : undefined;
		},
		async put(key, response) {
			held.set(key, {
				body: new Uint8Array(await response.arrayBuffer()),
				headers: Object.fromEntries(response.headers),
			});
		},
	};
}

export { STAMP };

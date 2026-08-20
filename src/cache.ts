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
				const fresh = await refresh;
				return { response: revive(fresh), ...produced(fresh.headers, now), cold: false };
			}
			// Behind the response, never in front of it. A failure here is
			// swallowed on purpose: the caller already has bytes, and the next
			// request sees the same staleness and tries again.
			opts.waitUntil(refresh.catch(() => undefined));
			return { response: hit, fetchedAt, ageSeconds, stale: true, cold: false };
		}
		return { response: hit, fetchedAt, ageSeconds, stale: false, cold: false };
	}

	const made = await once(key, () => replace(key, store, produce, now, false));
	const fresh = produced(made.headers, now);
	// Bytes can arrive already older than the TTL, because a cold producer may
	// hand over a snapshot another colo built. They are served, and the rebuild
	// they need runs behind the response like any other refresh.
	if (fresh.ageSeconds >= opts.ttlSeconds && !opts.blockUntilFresh) {
		opts.waitUntil(once(key, () => replace(key, store, produce, now, true)).catch(() => undefined));
	}
	return { response: revive(made), ...fresh, stale: fresh.ageSeconds >= opts.ttlSeconds, cold: true };
}

/**
 * produced reports the age of bytes this request just put in the cache.
 *
 * It reads the stamp rather than assuming zero: a snapshot another colo built
 * arrives already old, and it is stale the moment its age passes the TTL.
 */
function produced(
	headers: Headers,
	now: () => Date,
): { fetchedAt: Date; ageSeconds: number; stale: boolean } {
	const stamped = headers.get(STAMP);
	const fetchedAt = stamped ? new Date(stamped) : now();
	const ageSeconds = Math.max(0, Math.round((now().getTime() - fetchedAt.getTime()) / 1000));
	return { fetchedAt, ageSeconds, stale: false };
}

/**
 * Bytes that were just produced, held so the request that paid for them does not
 * have to ask the cache for them back.
 */
interface Made {
	bytes: ArrayBuffer;
	headers: Headers;
}

/**
 * replace produces the bytes, offers them to the store, and HANDS THEM BACK.
 *
 * Handing them back is the whole point. This used to write and then read the
 * same key, which made a cache write the service could not proceed without --
 * and the Cache API makes no such promise: it is per-datacenter, functional only
 * on a custom domain, and a no-op in a dashboard preview. So a put that did not
 * stick failed every request, with the answer already computed and in hand. A
 * cache is an optimization; losing one costs time, never correctness.
 *
 * The bytes are buffered rather than teed, because a tee hands one body to
 * whoever asked first and leaves every other caller of the same deduplicated
 * production holding a response that is already spent.
 */
async function replace(
	key: string,
	store: SWRStore,
	produce: (background: boolean) => Promise<Response>,
	now: () => Date,
	background: boolean,
): Promise<Made> {
	const stamped = stamp(await produce(background), now);
	const headers = new Headers(stamped.headers);
	const bytes = await stamped.arrayBuffer();
	// One ArrayBuffer, several Responses: constructing a Response from a buffer
	// copies it into the body rather than taking the buffer over, so the same
	// bytes back both the stored entry and every revive() below.
	await store.put(key, new Response(bytes, { headers }));
	return { bytes, headers };
}

/** revive builds a readable Response over bytes this request already holds. */
function revive(made: Made): Response {
	return new Response(made.bytes, { headers: made.headers });
}

export interface FetchOptions extends SWROptions {
	/** Injectable for tests; defaults to global fetch. */
	fetcher?: typeof fetch;
}

export interface CachedBody extends Omit<Cached, "response"> {
	/** The upstream bytes. */
	body: string;
}

/**
 * cacheKey puts an entry under a URL THIS service serves.
 *
 * The Cache API is the Worker's own store, and a Worker cannot affect the cache
 * of a zone it does not serve -- three of the four sources are foreign origins,
 * two of them behind Cloudflare themselves. Keying an entry by the upstream's
 * own URL therefore asks the cache to hold something on another zone's behalf,
 * which it declines, silently, every time.
 *
 * The path carries a version so a schema change is never answered out of the
 * previous shape's bytes.
 */
export function cacheKey(name: string): string {
	return `https://modelinfo.pazer.ai/__cache/v1/${encodeURIComponent(name)}`;
}

/** swrFetch is swr over an upstream document, handed back as text to parse. */
export async function swrFetch(url: string, opts: FetchOptions): Promise<CachedBody> {
	const doFetch = opts.fetcher ?? fetch;
	const { response, ...rest } = await swr(cacheKey(url), () => upstream(url, doFetch), opts);
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
	// A producer that knows when its bytes were built keeps that time. The
	// database can come from a snapshot another colo built, and a stamp written
	// here would call an hour-old copy fresh for another hour.
	if (!headers.has(STAMP)) headers.set(STAMP, now().toISOString());
	return new Response(res.body, { headers });
}

/**
 * held is this isolate's own copy of what it has produced.
 *
 * The Cache API is the durable layer and this is not a substitute for it: it
 * dies with the isolate and is not shared with any other. What it is, is the
 * layer that cannot decline a write. The Cache API can, for reasons a Worker
 * cannot see or test for -- an entry it will not hold, a key it will not accept,
 * a datacenter that has not got it -- and when it does, EVERY request pays the
 * full four-source ingest again. That is the difference between a 7 ms answer
 * and an 8 second one, per request, forever, with nothing in the logs.
 *
 * So the memo is not an optimization on top of a working cache. It is what
 * makes the service's speed a property of code we control rather than of a
 * cache's undocumented acceptance rules.
 */
const held = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();

/**
 * How many answers the memo holds. The database is one; the rest are list
 * responses, one per distinct filter, and a filter is anything a caller can put
 * in a query string. Without a cap that is an isolate-filling budget handed to
 * whoever is asking, so the oldest entry goes when a new one arrives.
 */
const MEMO_MAX_ENTRIES = 8;

function memoize(key: string, entry: { bytes: ArrayBuffer; headers: Headers }): void {
	held.delete(key);
	held.set(key, entry);
	while (held.size > MEMO_MAX_ENTRIES) {
		const oldest = held.keys().next();
		if (oldest.done) break;
		held.delete(oldest.value);
	}
}

/** Only for tests, which need each case to start from a cold isolate. */
export function forgetHeld(): void {
	held.clear();
}

/**
 * The Cache API keyed by URL, with this isolate's memo in front of it.
 *
 * workerd wants a Request rather than the string one -- a bare string reaches it
 * as something with no `.href` and the call fails -- so the key becomes a GET
 * Request here, which is also the only method `cache.put` accepts.
 *
 * A miss falls through to the Cache API and, on a hit there, is memoized: an
 * isolate that starts cold still pays only one round trip rather than one per
 * request.
 */
function defaultStore(): SWRStore {
	const cache = caches.default;
	return {
		async match(key) {
			const memo = held.get(key);
			if (memo) return new Response(memo.bytes, { headers: memo.headers });

			const stored = await cache.match(new Request(key, { method: "GET" }));
			if (!stored) return undefined;
			const headers = new Headers(stored.headers);
			const bytes = await stored.arrayBuffer();
			if (memoizable(key)) memoize(key, { bytes, headers });
			return new Response(bytes, { headers });
		},
		async put(key, response) {
			const headers = new Headers(response.headers);
			const bytes = await response.arrayBuffer();
			if (memoizable(key)) memoize(key, { bytes, headers });
			await cache.put(new Request(key, { method: "GET" }), new Response(bytes, { headers }));
		},
	};
}

/**
 * memoizable keeps this service's OWN answers in the isolate and leaves the
 * upstream documents to the Cache API.
 *
 * The four sources total about 22 MB and are read once, during a rebuild. The
 * database is 20 MB and is read by every route, on every request. Holding both
 * would put 42 MB in a 128 MB isolate to speed up the half that nobody waits
 * on; holding the answers alone is what the memo is for.
 */
function memoizable(key: string): boolean {
	const name = decodeURIComponent(key.slice(key.lastIndexOf("/") + 1));
	return !name.startsWith("http");
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

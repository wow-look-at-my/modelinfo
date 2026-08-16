/**
 * Stale-while-revalidate over the Workers Cache API.
 *
 * The rule this file exists to keep: a request never waits on an upstream that
 * has already answered once. Past the TTL the cached bytes are served AS THEY
 * ARE, and the refresh runs behind the response on ctx.waitUntil. Only a cold
 * cache blocks, because there is nothing else to serve.
 *
 * Freshness is decided here rather than by Cache-Control on the stored entry,
 * because the Cache API evicts an expired entry instead of handing it back --
 * which is exactly the stale copy this needs. So entries are stored
 * effectively immortal and stamped with STAMP; age is arithmetic we do.
 *
 * The cached bytes live in the Cache API, which is NOT the isolate's 128 MB
 * heap. A body becomes a JS string only when a caller asks for one, and a
 * background refresh never asks: it pipes the upstream stream straight into the
 * store. See docs/memory.md.
 */

/** The header carrying when the bytes were fetched. Ours, not the upstream's. */
const STAMP = "x-modelinfo-fetched-at";

/** Long enough that the Cache API never expires an entry out from under the SWR window. */
const STORE_SECONDS = 30 * 24 * 60 * 60;

export interface CachedBody {
	/** The upstream bytes. */
	body: string;
	/** When they were fetched. */
	fetchedAt: Date;
	/** Seconds old. */
	ageSeconds: number;
	/** True when past the TTL: these bytes were served while a refresh runs behind. */
	stale: boolean;
	/** True when nothing was cached and this request paid for the fetch. */
	cold: boolean;
}

export interface SWROptions {
	ttlSeconds: number;
	/** Where a background refresh is registered. */
	waitUntil(promise: Promise<unknown>): void;
	/** Injectable for tests; defaults to global fetch. */
	fetcher?: typeof fetch;
	/** Injectable for tests; defaults to caches.default. */
	store?: SWRStore;
	now?: () => Date;
}

/** The slice of the Cache API this uses, so a test can supply a Map. */
export interface SWRStore {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
}

/**
 * A cold fetch that fails is an ERROR the caller must report. A refresh that
 * fails keeps the stale bytes and is reported alongside them: the data is
 * usable and its age is stated, which is the difference between degraded and
 * broken.
 */
export async function swrFetch(url: string, opts: SWROptions): Promise<CachedBody> {
	const now = opts.now ?? (() => new Date());
	const store = opts.store ?? defaultStore();
	const doFetch = opts.fetcher ?? fetch;

	const hit = await store.match(url);
	if (hit) {
		const stampedAt = hit.headers.get(STAMP);
		const fetchedAt = stampedAt ? new Date(stampedAt) : new Date(0);
		const ageSeconds = Math.max(0, Math.round((now().getTime() - fetchedAt.getTime()) / 1000));
		const stale = ageSeconds >= opts.ttlSeconds;
		if (stale) {
			// Behind the response, never in front of it. A failure here is
			// swallowed on purpose: the caller already has bytes, and the next
			// request sees the same staleness and tries again.
			opts.waitUntil(once(url, () => stream(url, store, doFetch, now)).catch(() => undefined));
		}
		return { body: await hit.text(), fetchedAt, ageSeconds, stale, cold: false };
	}

	const body = await once(url, () => cold(url, store, doFetch, now));
	return { body, fetchedAt: now(), ageSeconds: 0, stale: false, cold: true };
}

/**
 * inFlight collapses concurrent refreshes of one URL into one request.
 *
 * Without it every request arriving in the stale window starts its own fetch,
 * so the moment an hour elapses the upstream takes a burst instead of a
 * request. It is per-isolate, which is all a Worker can offer and all this
 * needs: the burst it prevents is the one from a single isolate's own traffic.
 */
const inFlight = new Map<string, Promise<unknown>>();

function once<T>(url: string, work: () => Promise<T>): Promise<T> {
	const running = inFlight.get(url) as Promise<T> | undefined;
	if (running) return running;
	const started = work().finally(() => inFlight.delete(url));
	inFlight.set(url, started);
	return started;
}

/**
 * stream refreshes the store WITHOUT the bytes ever becoming a JS string.
 *
 * This is the background path, and it runs concurrently with the request that
 * triggered it. Four refreshes each materializing an 18 MB document alongside a
 * build is how the isolate's 128 MB goes; piping the upstream response straight
 * into the store costs the heap nothing.
 */
async function stream(
	url: string,
	store: SWRStore,
	doFetch: typeof fetch,
	now: () => Date,
): Promise<void> {
	const res = await upstream(url, doFetch);
	await store.put(url, new Response(res.body, { headers: storedHeaders(now) }));
}

/**
 * cold is the only path that materializes a body, because the caller is about
 * to parse it and there is nothing else to serve.
 */
async function cold(
	url: string,
	store: SWRStore,
	doFetch: typeof fetch,
	now: () => Date,
): Promise<string> {
	const res = await upstream(url, doFetch);
	const body = await res.text();
	if (!body.trim()) throw new Error(`${url} answered ${res.status} with an empty body`);
	// The Response wraps the same immutable string rather than copying it.
	await store.put(url, new Response(body, { headers: storedHeaders(now) }));
	return body;
}

async function upstream(url: string, doFetch: typeof fetch): Promise<Response> {
	const res = await doFetch(url, {
		headers: {
			accept: "application/json",
			"user-agent": "modelinfo (+https://github.com/wow-look-at-my/modelinfo)",
		},
	});
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return res;
}

function storedHeaders(now: () => Date): Record<string, string> {
	return {
		"content-type": "application/json",
		"cache-control": `public, max-age=${STORE_SECONDS}`,
		[STAMP]: now().toISOString(),
	};
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
	const held = new Map<string, { body: string; headers: Record<string, string> }>();
	return {
		async match(key) {
			const e = held.get(key);
			return e ? new Response(e.body, { headers: e.headers }) : undefined;
		},
		async put(key, response) {
			held.set(key, {
				body: await response.text(),
				headers: Object.fromEntries(response.headers),
			});
		},
	};
}

export { STAMP };

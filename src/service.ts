import { swr, type SWRStore } from "./cache.ts";
import { Catalogue } from "./catalogue.ts";
import { canonicalQuery, modeOf, parseFilter } from "./filter.ts";
import { ingest, TTL_SECONDS } from "./ingest.ts";
import type { Sqlite } from "./sqlite.ts";

/**
 * The routes, with the platform held at arm's length.
 *
 * index.ts owns the Worker: the WebAssembly import, `caches.default`, `env`. This
 * file owns what the service DOES, and takes its dependencies as arguments, so
 * every route is exercised by a test with no Worker runtime in sight.
 */
export interface Service {
	sqlite: Sqlite;
	waitUntil(promise: Promise<unknown>): void;
	fetcher?: typeof fetch;
	store?: SWRStore;
	now?: () => Date;
	ttlSeconds?: number;
}

/**
 * Cache keys. The Cache API wants URLs; nobody fetches these.
 *
 * They carry a version, so a schema change is never answered out of the previous
 * shape's bytes. They are CONSTANT rather than derived from the request, because
 * the hourly cron has no request to derive one from -- keying on the incoming
 * origin would have the schedule warm an entry no request ever reads.
 */
const KEYS = {
	database: "https://modelinfo.internal/v1/models.sqlite",
	list: "https://modelinfo.internal/v1/models",
};

export async function handle(request: Request, svc: Service): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: `${request.method} is not supported; this service is read-only` }, 405);
	}

	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const ttl = svc.ttlSeconds ?? TTL_SECONDS;

	if (path === "/db" || path === "/models.sqlite") return database(svc, ttl);
	if (path === "/" || path === "/health") return health(svc, ttl);
	if (path === "/v1/models" || path === "/models") return list(url, svc, ttl);

	const single = /^\/(?:v1\/)?models\/(.+)$/.exec(url.pathname);
	if (single) return one(decodeURIComponent(single[1]), svc, ttl);

	return json(
		{
			error: `no route for ${path}`,
			routes: ["/v1/models", "/v1/models/{id}", "/db", "/health"],
		},
		404,
	);
}

/**
 * The ingested database, cached for the TTL and served stale while it rebuilds.
 *
 * Every other route reads these same bytes, so the ingest runs once per isolate
 * per hour rather than once per request.
 */
async function cachedDatabase(svc: Service, ttl: number): Promise<Response> {
	const cached = await swr(
		KEYS.database,
		async (background) => {
			const bytes = await ingest({
				sqlite: svc.sqlite,
				waitUntil: svc.waitUntil,
				fetcher: svc.fetcher,
				store: svc.store,
				now: svc.now,
				ttlSeconds: ttl,
				// A rebuild running behind a response has nobody waiting on it, so
				// it takes the time to fetch sources that have gone stale rather
				// than baking their old bytes into the new database.
				blockUntilFresh: background,
			});
			return new Response(bytes, {
				headers: { "content-type": "application/vnd.sqlite3" },
			});
		},
		{ ttlSeconds: ttl, waitUntil: svc.waitUntil, store: svc.store, now: svc.now },
	);
	return cached.response;
}

async function withCatalogue<T>(
	svc: Service,
	ttl: number,
	use: (catalogue: Catalogue) => T | Promise<T>,
): Promise<T> {
	const bytes = new Uint8Array(await (await cachedDatabase(svc, ttl)).arrayBuffer());
	const catalogue = new Catalogue(svc.sqlite, bytes);
	try {
		return await use(catalogue);
	} finally {
		catalogue.close();
	}
}

/** /db -- the ingest itself, as a SQLite file anyone can download and query. */
async function database(svc: Service, ttl: number): Promise<Response> {
	const res = await cachedDatabase(svc, ttl);
	return new Response(res.body, {
		status: 200,
		headers: {
			"content-type": "application/vnd.sqlite3",
			"content-disposition": 'attachment; filename="modelinfo.sqlite"',
			"access-control-allow-origin": "*",
			"cache-control": `public, max-age=${ttl}, stale-while-revalidate=${ttl}`,
		},
	});
}

/**
 * /v1/models -- OpenAI's shape, streamed straight out of the database.
 *
 * The answer is cached for the same hour the sources are, keyed by the
 * NORMALIZED filter, so `?mode=chat,responses` and `?mode=responses,chat` are one
 * cache entry rather than two identical builds.
 */
async function list(url: URL, svc: Service, ttl: number): Promise<Response> {
	const filter = parseFilter(url.searchParams);
	if ("error" in filter) return json({ error: filter.error }, 400);

	const key = `${KEYS.list}?${canonicalQuery(filter)}`;
	const cached = await swr(
		key,
		async () => {
			// The catalogue must outlive the stream that reads from it, so this is
			// the one place that does not close it in a finally: the stream closes
			// it when it is done, and cancel() closes it when the reader gives up.
			const bytes = new Uint8Array(await (await cachedDatabase(svc, ttl)).arrayBuffer());
			const catalogue = new Catalogue(svc.sqlite, bytes);
			const at = svc.now ? svc.now() : new Date();
			const total = catalogue.total();
			const returned = catalogue.returned(filter);
			const sources = catalogue.sources(at, ttl);
			const degraded = catalogue.degraded();
			const meta = catalogue.meta();
			const body = catalogue.list(filter, (written) => ({
				builtAt: meta.built_at ?? "",
				ttlSeconds: ttl,
				total,
				returned: written,
				filter: {
					modes: filter.allModes ? "all" : filter.modes,
					providers: filter.providers,
					q: filter.query,
					excluded: total - returned,
				},
				sources,
				degraded,
				database: "/db",
			}));
			return new Response(closing(body, catalogue), {
				headers: { "content-type": "application/json; charset=utf-8" },
			});
		},
		{ ttlSeconds: ttl, waitUntil: svc.waitUntil, store: svc.store, now: svc.now },
	);

	return new Response(cached.response.body, {
		status: 200,
		headers: {
			...jsonHeaders(ttl),
			"x-modelinfo-cache": cached.cold ? "MISS" : cached.stale ? "STALE" : "HIT",
		},
	});
}

/** closing releases the database once the stream that reads it has finished. */
function closing(body: ReadableStream<Uint8Array>, catalogue: Catalogue): ReadableStream<Uint8Array> {
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk);
			},
			flush() {
				catalogue.close();
			},
		}),
	);
}

/** /v1/models/{id} -- one model, by any name it answers to. */
async function one(name: string, svc: Service, ttl: number): Promise<Response> {
	const at = svc.now ? svc.now() : new Date();
	return withCatalogue(svc, ttl, (catalogue) => {
		const model = catalogue.one(name);
		if (!model) {
			return json(
				{
					error: `no model named ${JSON.stringify(name)}`,
					// An ambiguous short name resolves to nothing on purpose, and a
					// caller has to be told which is which rather than left guessing.
					candidates: catalogue.suggest(name),
				},
				404,
			);
		}
		return json(
			{
				...model,
				modelinfo: {
					builtAt: catalogue.meta().built_at ?? "",
					ttlSeconds: ttl,
					mode: modeOf(model),
					sources: catalogue.sources(at, ttl),
					degraded: catalogue.degraded(),
					database: "/db",
				},
			},
			200,
			ttl,
		);
	});
}

/**
 * /health reports each source's age and error without serving the catalogue, so
 * a monitor asking whether the upstreams are answering does not pay for 20 MB.
 */
async function health(svc: Service, ttl: number): Promise<Response> {
	const at = svc.now ? svc.now() : new Date();
	return withCatalogue(svc, ttl, (catalogue) => {
		const degraded = catalogue.degraded();
		const meta = catalogue.meta();
		return json(
			{
				ok: degraded.length === 0,
				builtAt: meta.built_at ?? "",
				ttlSeconds: ttl,
				models: Number(meta.models ?? 0),
				records: Number(meta.records ?? 0),
				aliases: Number(meta.aliases ?? 0),
				sourceOrder: (meta.source_order ?? "").split(",").filter(Boolean),
				sources: catalogue.sources(at, ttl),
				degraded,
				routes: ["/v1/models", "/v1/models/{id}", "/db", "/health"],
			},
			degraded.length === 0 ? 200 : 503,
		);
	});
}

function jsonHeaders(ttlSeconds?: number): Record<string, string> {
	return {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		// The same hour the sources get, and the same posture: a client may serve
		// this while it refetches behind the scenes.
		"cache-control":
			ttlSeconds === undefined
				? "no-store"
				: `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`,
	};
}

function json(body: unknown, status: number, ttlSeconds?: number): Response {
	return new Response(JSON.stringify(body), { status, headers: jsonHeaders(ttlSeconds) });
}

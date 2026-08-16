import { build, TTL_SECONDS, type BuildOptions, type Catalogue } from "./build.ts";
import { applyFilter, canonicalQuery, modeOf, parseFilter } from "./filter.ts";
import { jsonListStream } from "./stream.ts";
import { lower } from "./merge.ts";
import type { Model, SourceReport } from "./types.ts";

export interface Env {
	/** Overrides the one-hour TTL. Unset is the default; unparseable is an error. */
	MODELINFO_TTL_SECONDS?: string;
}

/**
 * The answer's own envelope. `object` and `data` are exactly OpenAI's
 * `/v1/models`, so a client that knows nothing about this service reads it
 * unchanged. Everything this service adds sits under `modelinfo`, a name OpenAI
 * does not use.
 */
interface ListResponse {
	object: "list";
	data: Model[];
	modelinfo: {
		builtAt: string;
		ttlSeconds: number;
		/** Models before the filter, and after it. */
		total: number;
		returned: number;
		filter: {
			modes: string[] | "all";
			providers: string[];
			q: string;
			excluded: number;
		};
		sources: SourceReport[];
		/** Sources that could not be read. Non-empty means `data` is incomplete. */
		degraded: string[];
	};
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			return await route(request, env, ctx);
		} catch (err) {
			// A failure here is reported as one. There is no shape of this
			// service that answers 200 with nothing in it.
			return json({ error: err instanceof Error ? err.message : String(err) }, 502);
		}
	},
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return json({ error: `${request.method} is not supported; this service is read-only` }, 405);
	}

	const url = new URL(request.url);
	const path = url.pathname.replace(/\/+$/, "") || "/";
	const ttlSeconds = ttlOf(env);
	const opts: BuildOptions = { waitUntil: (p) => ctx.waitUntil(p), ttlSeconds };

	if (path === "/" || path === "/health") return health(opts, ttlSeconds);
	if (path === "/v1/models" || path === "/models") return list(request, url, opts, ttlSeconds);

	const single = /^\/(?:v1\/)?models\/(.+)$/.exec(url.pathname);
	if (single) return one(decodeURIComponent(single[1]), opts, ttlSeconds);

	return json(
		{
			error: `no route for ${path}`,
			routes: ["/v1/models", "/v1/models/{id}", "/health"],
		},
		404,
	);
}

/**
 * The answer is cached for the same hour the sources are, keyed by the
 * NORMALIZED filter, so `?mode=chat,responses` and `?mode=responses,chat` are
 * one cache entry rather than two builds of identical bytes.
 */
async function list(
	request: Request,
	url: URL,
	opts: BuildOptions,
	ttlSeconds: number,
): Promise<Response> {
	const filter = parseFilter(url.searchParams);
	if ("error" in filter) return json({ error: filter.error }, 400);

	const key = new Request(
		`${url.origin}/v1/models?${canonicalQuery(filter)}`,
		{ method: "GET" },
	);
	const cached = await caches.default.match(key);
	if (cached) return withVia(cached, "HIT");

	const catalogue = await build(opts);
	const { models, excluded } = applyFilter(catalogue.models, filter);

	const body = jsonListStream(models, (returned) => ({
		builtAt: catalogue.builtAt.toISOString(),
		ttlSeconds,
		total: catalogue.models.length,
		returned,
		filter: {
			modes: filter.allModes ? "all" : filter.modes,
			providers: filter.providers,
			q: filter.query,
			excluded,
		},
		sources: catalogue.reports,
		degraded: catalogue.degraded,
	}));

	const response = new Response(body, { status: 200, headers: jsonHeaders(ttlSeconds) });
	// tee, not clone: clone() on a streamed body buffers the whole thing in
	// memory to feed the second reader, which is the allocation this avoided.
	const [toClient, toCache] = response.body!.tee();
	opts.waitUntil(
		caches.default.put(key, new Response(toCache, { headers: jsonHeaders(ttlSeconds) })),
	);
	return new Response(toClient, {
		status: 200,
		headers: { ...jsonHeaders(ttlSeconds), "x-modelinfo-cache": "MISS" },
	});
}

/** One model, by any name it answers to. */
async function one(name: string, opts: BuildOptions, ttlSeconds: number): Promise<Response> {
	const catalogue = await build(opts);
	const model = resolve(catalogue, name);
	if (!model) {
		return json(
			{
				error: `no model named ${JSON.stringify(name)}`,
				// An ambiguous short name resolves to nothing on purpose, and a
				// caller has to be told which is which rather than left guessing.
				candidates: suggest(catalogue, name),
			},
			404,
		);
	}
	return json(
		{
			...model,
			modelinfo: {
				builtAt: catalogue.builtAt.toISOString(),
				ttlSeconds,
				mode: modeOf(model),
				sources: catalogue.reports,
				degraded: catalogue.degraded,
			},
		},
		200,
		ttlSeconds,
	);
}

function resolve(catalogue: Catalogue, name: string): Model | undefined {
	const id = catalogue.index.get(lower(name));
	return id ? catalogue.models.find((m) => m.id === id) : undefined;
}

/** Up to ten ids containing the name, so a 404 is actionable. */
function suggest(catalogue: Catalogue, name: string): string[] {
	const needle = lower(name);
	const out: string[] = [];
	for (const model of catalogue.models) {
		if (lower(model.id).includes(needle) || model.aliases.some((a) => lower(a).includes(needle))) {
			out.push(model.id);
			if (out.length === 10) break;
		}
	}
	return out;
}

/**
 * health reports each source's age and error without serving the catalogue, so
 * a monitor asking whether the upstreams are answering does not pay for 20 MB.
 */
async function health(opts: BuildOptions, ttlSeconds: number): Promise<Response> {
	const catalogue = await build(opts);
	return json(
		{
			ok: catalogue.degraded.length === 0,
			builtAt: catalogue.builtAt.toISOString(),
			ttlSeconds,
			models: catalogue.models.length,
			sources: catalogue.reports,
			degraded: catalogue.degraded,
		},
		catalogue.degraded.length === 0 ? 200 : 503,
	);
}

/**
 * ttlOf reads the one knob. An unparseable value FAILS rather than falling back
 * to the default: a typo that silently reverts to an hour is a setting the
 * operator believes they changed.
 */
function ttlOf(env: Env): number {
	const raw = env.MODELINFO_TTL_SECONDS?.trim();
	if (!raw) return TTL_SECONDS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`MODELINFO_TTL_SECONDS is ${JSON.stringify(raw)}, which is not a positive number of seconds`);
	}
	return Math.floor(n);
}

function jsonHeaders(ttlSeconds?: number): Record<string, string> {
	return {
		"content-type": "application/json; charset=utf-8",
		"access-control-allow-origin": "*",
		// The same hour the sources get, and the same posture: a client may
		// serve this while it refetches behind the scenes.
		"cache-control":
			ttlSeconds === undefined
				? "no-store"
				: `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds}`,
	};
}

function json(body: unknown, status: number, ttlSeconds?: number): Response {
	return new Response(JSON.stringify(body), { status, headers: jsonHeaders(ttlSeconds) });
}

function withVia(response: Response, state: "HIT" | "MISS"): Response {
	const out = new Response(response.body, response);
	out.headers.set("x-modelinfo-cache", state);
	return out;
}

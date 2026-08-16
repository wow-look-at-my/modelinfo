import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/service.ts";
import { SOURCES } from "../src/sources.ts";
import type { Model } from "../src/types.ts";
import { fixtureFetcher, harness, settle, type Harness } from "./helpers.ts";

const AT = "https://modelinfo.pazer.ai";

function get(h: Harness, path: string): Promise<Response> {
	return handle(new Request(AT + path), h);
}

async function listOf(h: Harness, path: string): Promise<{ data: Model[]; modelinfo: Record<string, unknown> }> {
	const res = await get(h, path);
	assert.equal(res.status, 200, `${path} -> ${res.status}`);
	return (await res.json()) as never;
}

test("/v1/models is OpenAI's shape with this service's extras beside it", async () => {
	const h = await harness();
	const body = await listOf(h, "/v1/models");
	assert.ok(Array.isArray(body.data));
	assert.ok(body.data.length > 0);
	for (const model of body.data) {
		assert.equal(model.object, "model");
		assert.equal(typeof model.id, "string");
		assert.equal(typeof model.created, "number");
		assert.equal(typeof model.owned_by, "string");
	}
	// The envelope names where the numbers came from and what was hidden.
	assert.equal(body.modelinfo.database, "/db");
	assert.deepEqual(body.modelinfo.degraded, []);
	assert.equal((body.modelinfo.sources as unknown[]).length, SOURCES.length);
});

test("the default hides the gimmicks and says how many", async () => {
	const h = await harness();
	const dflt = await listOf(h, "/v1/models");
	const all = await listOf(h, "/v1/models?mode=all");

	const modes = (list: Model[]) => new Set(list.map((m) => String(m.mode ?? "")));
	assert.ok(all.data.length > dflt.data.length);
	assert.ok(
		[...modes(all.data)].some((m) => m.includes("image")),
		"the unfiltered list has image models",
	);
	assert.ok(
		![...modes(dflt.data)].some((m) => m.includes("image")),
		"the default list does not",
	);
	// Never silent: the count of what the filter removed rides in the answer.
	const filter = dflt.modelinfo.filter as { excluded: number };
	assert.equal(filter.excluded, (all.modelinfo.total as number) - dflt.data.length);
});

test("an unknown query parameter is refused rather than ignored", async () => {
	const h = await harness();
	const res = await get(h, "/v1/models?modes=chat");
	assert.equal(res.status, 400);
	assert.match(((await res.json()) as { error: string }).error, /unknown parameter "modes"/);
});

test("a filter is normalized before it becomes a cache key", async () => {
	const h = await harness();
	const one = await get(h, "/v1/models?mode=chat,completion");
	await one.text();
	const two = await get(h, "/v1/models?mode=completion,chat");
	await two.text();
	assert.equal(one.headers.get("x-modelinfo-cache"), "MISS");
	assert.equal(two.headers.get("x-modelinfo-cache"), "HIT");
});

test("/v1/models/{id} answers to any name the model has", async () => {
	const h = await harness();
	for (const name of ["anthropic/claude-opus-5", "claude-opus-5"]) {
		const res = await get(h, `/v1/models/${encodeURIComponent(name)}`);
		assert.equal(res.status, 200, name);
		const model = (await res.json()) as Model & { modelinfo: { mode: string } };
		assert.equal(model.id, "anthropic/claude-opus-5");
		assert.equal(model.modelinfo.mode, "chat");
		assert.ok(model.pricing.prompt, `${name} has a prompt rate`);
	}
});

test("a name that resolves to nothing is a 404 with candidates", async () => {
	const h = await harness();
	const res = await get(h, "/v1/models/opus");
	assert.equal(res.status, 404);
	const body = (await res.json()) as { error: string; candidates: string[] };
	assert.match(body.error, /no model named/);
	assert.ok(body.candidates.length > 0, "a 404 a caller can act on");
	assert.ok(body.candidates.some((c) => c.includes("opus")));
});

test("/db serves a real SQLite file", async () => {
	const h = await harness();
	const res = await get(h, "/db");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "application/vnd.sqlite3");
	assert.match(String(res.headers.get("content-disposition")), /modelinfo\.sqlite/);

	const bytes = new Uint8Array(await res.arrayBuffer());
	assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), "SQLite format 3");

	// And it opens, and answers the same question the API does.
	const db = new h.sqlite.Database(bytes);
	try {
		const viaSql = db.exec("SELECT COUNT(*) FROM model")[0].values[0][0];
		const viaApi = (await listOf(h, "/v1/models?mode=all")).modelinfo.total;
		assert.equal(Number(viaSql), Number(viaApi));
	} finally {
		db.close();
	}
});

test("/health reports each source without serving the catalogue", async () => {
	const h = await harness();
	const res = await get(h, "/health");
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		ok: boolean;
		models: number;
		sources: { name: string }[];
		sourceOrder: string[];
	};
	assert.equal(body.ok, true);
	assert.ok(body.models > 0);
	assert.deepEqual(
		body.sources.map((s) => s.name),
		body.sourceOrder,
	);
});

test("a degraded build answers 503 on /health and still serves the models it has", async () => {
	const h = await harness({
		fetcher: fixtureFetcher({ [SOURCES[0].url]: () => new Response("nope", { status: 503 }) }),
	});
	const health = await get(h, "/health");
	assert.equal(health.status, 503);
	assert.deepEqual(((await health.json()) as { degraded: string[] }).degraded, ["openrouter"]);

	const body = await listOf(h, "/v1/models?mode=all");
	assert.ok(body.data.length > 0, "the sources that answered still produce a catalogue");
	assert.deepEqual(body.modelinfo.degraded, ["openrouter"]);
});

test("the sources are read once per TTL", async () => {
	const h = await harness();
	await (await get(h, "/health")).text();
	const afterCold = h.count();
	assert.equal(afterCold, SOURCES.length, "one fetch per source");

	// Inside the hour: nothing is refetched, and nothing is rebuilt.
	await (await get(h, "/health")).text();
	await (await get(h, "/v1/models")).text();
	assert.equal(h.count(), afterCold);
});

test("a stale answer is served in full while the upstreams are still hanging", async () => {
	// The guarantee is not "no fetch is issued" -- a refresh starts the moment it
	// is scheduled. It is that the RESPONSE does not wait for one. So every
	// upstream is made to hang forever, and the stale request has to come back
	// anyway, complete, out of the previous hour's bytes.
	const fixtures = fixtureFetcher();
	let hang = false;
	const held: (() => void)[] = [];
	const h = await harness({
		fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (!hang) return fixtures(input, init);
			return new Promise<Response>((resolve) => {
				held.push(() => resolve(new Response("{}", { status: 200 })));
			});
		}) as typeof fetch,
	});

	const first = await get(h, "/v1/models");
	const before = await first.text();
	assert.equal(first.headers.get("x-modelinfo-cache"), "MISS");

	hang = true;
	h.setNow(new Date("2026-08-16T02:00:00.000Z"));
	const stale = await get(h, "/v1/models");
	assert.equal(stale.status, 200);
	assert.equal(stale.headers.get("x-modelinfo-cache"), "STALE");
	assert.equal(await stale.text(), before, "byte for byte the previous answer");
	assert.ok(held.length > 0, "and a refresh really is in flight behind it");
});

test("a background rebuild reads the upstreams rather than baking stale copies in", async () => {
	const h = await harness();
	await (await get(h, "/v1/models")).text();
	const afterCold = h.count();

	h.setNow(new Date("2026-08-16T02:00:00.000Z"));
	await (await get(h, "/v1/models")).text();
	await settle(h);

	// Exactly one refetch per source: the rebuild waited for fresh documents,
	// and the in-flight map kept the database rebuild and the answer rebuild from
	// asking for them twice.
	assert.equal(h.count(), afterCold + SOURCES.length);
});

test("x-modelinfo-cache describes the answer, and the sources report their own age", async () => {
	const h = await harness();
	await (await get(h, "/v1/models")).text();
	h.setNow(new Date("2026-08-16T02:00:00.000Z"));

	// A filter nobody has asked for yet is a MISS even though the database it is
	// built from is stale -- so the age of the DATA is reported per source, where
	// a caller can actually see it.
	const fresh = await get(h, "/v1/models?provider=openai");
	assert.equal(fresh.headers.get("x-modelinfo-cache"), "MISS");
	const body = (await fresh.json()) as { modelinfo: { sources: { stale: boolean }[] } };
	assert.ok(
		body.modelinfo.sources.every((s) => s.stale),
		"every source says it was past its TTL",
	);
});

test("a write method is refused", async () => {
	const h = await harness();
	const res = await handle(new Request(AT + "/v1/models", { method: "POST" }), h);
	assert.equal(res.status, 405);
});

test("an unrouted path lists the routes that exist", async () => {
	const h = await harness();
	const res = await get(h, "/nope");
	assert.equal(res.status, 404);
	const body = (await res.json()) as { routes: string[] };
	assert.ok(body.routes.includes("/db"));
});

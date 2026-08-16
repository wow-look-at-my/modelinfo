import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Catalogue } from "../src/catalogue.ts";
import { parseFilter } from "../src/filter.ts";
import { ingest } from "../src/ingest.ts";
import type { Sqlite, SqlValue } from "../src/sqlite.ts";
import { SOURCES } from "../src/sources.ts";
import { FIXTURES, fixtureFetcher, harness, type Harness } from "./helpers.ts";

async function built(h: Harness): Promise<{ bytes: Uint8Array; sqlite: Sqlite }> {
	const bytes = await ingest({
		sqlite: h.sqlite,
		waitUntil: h.waitUntil,
		fetcher: h.fetcher,
		store: h.store,
		now: h.now,
	});
	return { bytes, sqlite: h.sqlite };
}

function rows(sqlite: Sqlite, bytes: Uint8Array, sql: string): SqlValue[][] {
	const db = new sqlite.Database(bytes);
	try {
		return db.exec(sql)[0]?.values ?? [];
	} finally {
		db.close();
	}
}

test("the ingest produces a real SQLite file", async () => {
	const h = await harness();
	const { bytes } = await built(h);
	// The format's own magic string. This is what makes /db a file anything
	// speaking SQLite can open, rather than bytes we called a database.
	assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), "SQLite format 3");
	assert.ok(bytes.length > 4096, "a database with rows in it is more than one page");
});

test("every source's records are stored verbatim, under its own key", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const found = rows(
		sqlite,
		bytes,
		"SELECT source, source_key, doc FROM record WHERE join_key = 'openai/gpt-5.2' ORDER BY priority",
	);
	const bySource = Object.fromEntries(found.map((r) => [String(r[0]), r]));

	// litellm calls it gpt-5.2 and OpenRouter calls it openai/gpt-5.2. One model,
	// and each source's own spelling survives as the key it was stored under.
	assert.equal(String(bySource.litellm[1]), "gpt-5.2");
	assert.equal(String(bySource.openrouter[1]), "openai/gpt-5.2");
	// Verbatim: the stored bytes still parse, and still say what the source said.
	const doc = JSON.parse(String(bySource.litellm[2])) as Record<string, unknown>;
	assert.equal(doc.litellm_provider, "openai");
});

test("record_full reconstructs every record exactly as its source published it", async () => {
	// The largest object-valued field is held once in `blob` and referenced, which
	// is 14.6 MB off the real documents. That is only allowed to be a storage
	// decision: what comes back out has to be what went in, field for field, for
	// every record of every source.
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const stored = new Map<string, unknown>();
	for (const v of rows(sqlite, bytes, "SELECT source, source_key, doc FROM record_full")) {
		stored.set(`${String(v[0])} ${String(v[1])}`, JSON.parse(String(v[2])));
	}

	let checked = 0;
	for (const source of SOURCES) {
		const text = fs.readFileSync(path.join(FIXTURES, `${source.name}.json`), "utf8");
		const doc = JSON.parse(text) as Record<string, unknown>;
		const published: [string, unknown][] = source.envelope
			? (doc[source.envelope] as Record<string, unknown>[]).map((r) => [
					String(r[source.idField]),
					r,
				])
			: Object.entries(doc);
		for (const [key, value] of published) {
			if (source.skip.includes(key)) continue;
			assert.deepEqual(stored.get(`${source.name} ${key}`), value, `${source.name} ${key}`);
			checked++;
		}
	}
	assert.ok(checked > 60, `${checked} records compared`);

	const lifted = Number(
		rows(sqlite, bytes, "SELECT COUNT(*) FROM record WHERE field IS NOT NULL")[0][0],
	);
	assert.ok(lifted > 0, "and some of them really did have a field lifted out");
});

test("a value two models share is stored once", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const [references, distinct] = rows(
		sqlite,
		bytes,
		"SELECT (SELECT COUNT(*) FROM record WHERE blob_id IS NOT NULL), (SELECT COUNT(*) FROM blob)",
	)[0];
	assert.ok(Number(references) > Number(distinct), `${references} references, ${distinct} values`);
});

test("litellm's sample_spec is documentation, not a model", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	assert.deepEqual(rows(sqlite, bytes, "SELECT * FROM record WHERE source_key = 'sample_spec'"), []);
});

test("a provider-prefixed twin stays a separate model", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const ids = rows(sqlite, bytes, "SELECT id FROM model WHERE id LIKE '%gpt-5.2'").map((r) =>
		String(r[0]),
	);
	// Same weights, different bill.
	assert.ok(ids.includes("openai/gpt-5.2"), ids.join(", "));
	assert.ok(ids.includes("azure/gpt-5.2"), ids.join(", "));
});

test("a name two models claim resolves to neither", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		// gpt-image-1.5 is a literal litellm key AND the base_model of nineteen
		// size-and-quality variants. The literal key wins, because a source used
		// it; the derived claims are the weaker tier.
		assert.equal(catalogue.resolve("gpt-image-1.5"), "openai/gpt-image-1.5");
		// azure/gpt-image-1.5 shares that base_model and must not answer to it.
		assert.ok(catalogue.resolve("azure/gpt-image-1.5"));
		assert.notEqual(catalogue.resolve("azure/gpt-image-1.5"), catalogue.resolve("gpt-image-1.5"));
	} finally {
		catalogue.close();
	}
});

test("a short name answers when exactly one model claims it", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		assert.equal(catalogue.resolve("claude-opus-5"), "anthropic/claude-opus-5");
		const model = catalogue.one("claude-opus-5");
		assert.ok(model);
		assert.equal(model.id, "anthropic/claude-opus-5");
		// Every source that had something to say about it is named.
		assert.ok(model.sources.length >= 2, model.sources.join(","));
		// And it is priced, which is the entire point of the service.
		assert.ok(model.pricing.prompt, JSON.stringify(model.pricing));
		assert.ok(model.pricing.completion, JSON.stringify(model.pricing));
	} finally {
		catalogue.close();
	}
});

test("a source that fails is recorded as failed and contributes nothing", async () => {
	const h = await harness({
		fetcher: fixtureFetcher({
			[SOURCES[0].url]: () => new Response("nope", { status: 503 }),
		}),
	});
	const bytes = await ingest({
		sqlite: h.sqlite,
		waitUntil: h.waitUntil,
		fetcher: h.fetcher,
		store: h.store,
		now: h.now,
	});
	const catalogue = new Catalogue(h.sqlite, bytes);
	try {
		assert.deepEqual(catalogue.degraded(), ["openrouter"]);
		const report = catalogue.sources(h.now!(), 3600).find((s) => s.name === "openrouter");
		assert.match(String(report?.error), /503/);
		assert.equal(report?.models, 0);
		// The other three still built a catalogue, and it says so rather than
		// pretending to be complete.
		assert.ok(catalogue.total() > 10);
	} finally {
		catalogue.close();
	}
});

test("a build with no usable source throws rather than serving an empty catalogue", async () => {
	const h = await harness({
		fetcher: fixtureFetcher(
			Object.fromEntries(SOURCES.map((s) => [s.url, () => new Response("nope", { status: 500 })])),
		),
	});
	await assert.rejects(
		() =>
			ingest({
				sqlite: h.sqlite,
				waitUntil: h.waitUntil,
				fetcher: h.fetcher,
				store: h.store,
				now: h.now,
			}),
		/every source failed/,
	);
});

test("a source serving the wrong shape fails loudly", async () => {
	const h = await harness({
		fetcher: fixtureFetcher({
			[SOURCES[3].url]: () => new Response("<html>rate limited</html>", { status: 200 }),
		}),
	});
	const bytes = await ingest({
		sqlite: h.sqlite,
		waitUntil: h.waitUntil,
		fetcher: h.fetcher,
		store: h.store,
		now: h.now,
	});
	const catalogue = new Catalogue(h.sqlite, bytes);
	try {
		assert.deepEqual(catalogue.degraded(), ["litellm"]);
	} finally {
		catalogue.close();
	}
});

test("the filter runs in SQL and reports what it removed", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		const all = parseFilter(new URLSearchParams("mode=all"));
		const dflt = parseFilter(new URLSearchParams());
		assert.ok(!("error" in all) && !("error" in dflt));
		const total = catalogue.total();
		assert.equal(catalogue.returned(all), total, "mode=all excludes nothing");
		assert.ok(catalogue.returned(dflt) < total, "the default hides the gimmicks");

		const openai = parseFilter(new URLSearchParams("mode=all&provider=openai"));
		assert.ok(!("error" in openai));
		const only = catalogue.returned(openai);
		assert.ok(only > 0 && only < total);
	} finally {
		catalogue.close();
	}
});

test("meta records what the build did, so /db explains itself", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		const meta = catalogue.meta();
		assert.equal(meta.built_at, h.now!().toISOString());
		assert.equal(meta.ttl_seconds, "3600");
		assert.equal(
			meta.source_order,
			"openrouter,bifrost-datasheet,bifrost-parameters,litellm",
		);
		assert.equal(Number(meta.models), catalogue.total());
		assert.ok(Number(meta.records) > Number(meta.models));
		assert.equal(meta.degraded, "");
	} finally {
		catalogue.close();
	}
});

test("two ingests of one input produce identical bytes", async () => {
	const a = await harness();
	const b = await harness();
	const first = await built(a);
	const second = await built(b);
	assert.deepEqual(first.bytes, second.bytes);
});

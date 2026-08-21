import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Catalogue } from "../src/catalogue.ts";
import { parseFilter } from "../src/filter.ts";
import { ingest, recordsOf } from "../src/ingest.ts";
import { handle } from "../src/service.ts";
import type { Sqlite, SqlValue } from "../src/sqlite.ts";
import { SOURCES } from "../src/sources.ts";
import { fixtureFile, fixtureFetcher, harness, type Harness } from "./helpers.ts";

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
		const text = fs.readFileSync(fixtureFile(source), "utf8");
		// The shipped reading path is the source of truth for what each source
		// published: it handles JSON objects, enveloped arrays, crof's
		// HTML-embedded array and ollama's transcribed markup, so this test
		// compares against exactly what ingest stored rather than a hand-rolled
		// reading of the fixture.
		const published: [string, unknown][] = [];
		for (const [key, raw] of recordsOf(source, text)) {
			const record = JSON.parse(raw) as Record<string, unknown>;
			const id = source.envelope || source.htmlAnchor ? String(record[source.idField]) : key;
			published.push([id, record]);
		}

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

test("a source's own documentation and routing rules are not models", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	// sample_spec is litellm's documentation of its own schema.
	assert.deepEqual(rows(sqlite, bytes, "SELECT * FROM record WHERE source_key = 'sample_spec'"), []);
	// fallback_generalizations is its table of id-pattern routing rules, and it
	// reaches bifrost-datasheet too -- which adds a `base_model` to it, so left
	// in it is a model named after a rule table that also claims an alias.
	assert.deepEqual(
		rows(sqlite, bytes, "SELECT * FROM record WHERE source_key = 'fallback_generalizations'"),
		[],
	);
	assert.deepEqual(
		rows(sqlite, bytes, "SELECT id FROM model WHERE id LIKE '%fallback_generalizations%'"),
		[],
	);
	// And nothing answers to it, which a skipped record's base_model could
	// otherwise still have claimed.
	assert.deepEqual(
		rows(sqlite, bytes, "SELECT name FROM alias WHERE name LIKE '%fallback%'"),
		[],
	);
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
			[SOURCES.find((s) => s.name === "litellm")!.url]: () =>
				new Response("<html>rate limited</html>", { status: 200 }),
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
			"openrouter,ollama-library,bifrost-datasheet,bifrost-parameters,litellm,crof",
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

// crof.ai is the fifth source: its pricing page inlines an `allModels` array in
// HTML (no public API), and it is the only source publishing per-model `speed`
// (tok/s), `cache_rate`, and `quantization`, and the only one whose prices are
// per MILLION tokens. These tests drive the real ingest+fold path against a
// real slice of the page (test/fixtures/crof.html), not pre-extracted JSON.

const CROF = SOURCES.find((s) => s.name === "crof")!;
const AT = "https://modelinfo.pazer.ai";

test("crof is ingested as a source: its models appear in record and model under a crof source", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);

	// criterion 1: a crof model from the page is in the `record` table, under a
	// crof source -- proving the page's data was pulled in, not just registered.
	const rec = rows(sqlite, bytes, [
		"SELECT source, source_key FROM record",
		"WHERE join_key = 'deepseek-v4-pro-0813' AND source = 'crof'",
	].join(" "));
	assert.equal(rec.length, 1, "a crof row for deepseek-v4-pro-0813");
	assert.equal(String(rec[0][1]), "deepseek-v4-pro-0813");

	// ...and in the `model` table.
	const mdl = rows(sqlite, bytes, "SELECT id FROM model WHERE id = 'deepseek-v4-pro-0813'");
	assert.equal(mdl.length, 1, "a model row for deepseek-v4-pro-0813");

	// crof contributed all 20 models from the page, and the build is not degraded.
	const crofCount = Number(rows(sqlite, bytes, "SELECT COUNT(*) FROM record WHERE source = 'crof'")[0][0]);
	assert.equal(crofCount, 20, "all 20 models from the page's allModels array");
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		assert.deepEqual(catalogue.degraded(), []);
		assert.ok(catalogue.sources(h.now!(), 3600).some((s) => s.name === "crof" && s.models === 20));
	} finally {
		catalogue.close();
	}
});

test("crof's per-million prices enter unified pricing in USD-per-token, scaled by 1e6", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		// criterion 2: the page lists prompt "0.35" (per million); pricing.prompt
		// is "0.00000035" (per token), and completion/cache_prompt likewise scaled.
		const model = catalogue.one("deepseek-v4-pro-0813");
		assert.ok(model, "deepseek-v4-pro-0813 folded");
		assert.equal(model.pricing.prompt, "0.00000035", "0.35 / 1e6 per token");
		assert.equal(model.pricing.completion, "0.00000080", "0.80 / 1e6 per token");
		assert.equal(model.pricing.cache_prompt, "0.00000001", "0.01 / 1e6 per token");

		// The scaling is at FOLD time, not in storage: the stored doc keeps crof's
		// verbatim per-million values (record.doc is the source's own bytes), so a
		// 1e6x error in `pricing` is not hiding a 1e6x error in the database.
		const doc = rows(sqlite, bytes, "SELECT doc FROM record_full WHERE source = 'crof' AND source_key = 'deepseek-v4-pro-0813'")[0][0];
		const stored = JSON.parse(String(doc)) as { pricing: { prompt: string } };
		assert.equal(stored.pricing.prompt, "0.35", "doc kept crof's per-million value verbatim");
	} finally {
		catalogue.close();
	}
});

test("crof's speed (tok/s) and page-only facts survive on the merged record", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	const catalogue = new Catalogue(sqlite, bytes);
	try {
		// criterion 3: speed (tokens/sec) plus at least one other page-only fact
		// (cache_rate or quantization) survive on the merged crof record.
		const model = catalogue.one("deepseek-v4-pro-0813");
		assert.ok(model);
		assert.equal(model.speed, 83, "tok/s");
		assert.equal(model.cache_rate, 81);
		assert.equal(model.quantization, "Q8_0");
		assert.equal(model.context_length, "1,000,000", "crof's own value, verbatim");
		assert.equal(model.created, 1786736315, "crof's epoch seconds");

		// crof's pricing metadata (discount, *_original) is not in unified pricing
		// but survives as crof's own fields -- nothing is dropped.
		const glm = catalogue.one("glm-5.2");
		assert.ok(glm);
		assert.ok(!("discount" in glm.pricing), JSON.stringify(glm.pricing));
		assert.equal(glm.discount, 50.0);
		assert.equal(glm.prompt_original, "0.30");
	} finally {
		catalogue.close();
	}
});

test("a crof source failure is reported, not silently dropped", async () => {
	// criterion 4: when crof's page (or its inline array) cannot be read, crof is
	// named in `degraded` and /health (503), and the build still succeeds off the
	// other sources. It throws only if EVERY source fails.
	const h = await harness({
		fetcher: fixtureFetcher({
			// A page that dropped the array anchor: a real crof failure mode (a
			// redesign that moved allModels), served as HTML so the anchor scan
			// is what fails -- not a content-type or status quirk.
			[CROF.url]: () => new Response("<html><script>const models = [];</script></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
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
		// crof is named in degraded...
		assert.deepEqual(catalogue.degraded(), ["crof"]);
		const report = catalogue.sources(h.now!(), 3600).find((s) => s.name === "crof");
		assert.match(String(report?.error), /allModels/);
		assert.equal(report?.models, 0);
		// ...and the other four still built a usable catalogue.
		assert.ok(catalogue.total() > 10, "the other sources still produce a catalogue");
	} finally {
		catalogue.close();
	}

	// /health answers 503 and names crof.
	const health = await handle(new Request(AT + "/health"), h);
	assert.equal(health.status, 503);
	const body = (await health.json()) as { degraded: string[] };
	assert.deepEqual(body.degraded, ["crof"]);
});

test("a build where every source fails, including crof, still throws", async () => {
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

// ollama.com/library is the sixth source, and the only one that knows which
// ollama models embed: bifrost publishes `mode: "chat"` for 6,308 of its 6,321
// ollama keys, embedding models included, and litellm's 29 ollama entries are
// chat or completion. These tests drive the real ingest+fold path over a real
// slice of the page (test/fixtures/ollama-library.html) and real bifrost
// records for three ollama tags.

function modeOfModel(sqlite: Sqlite, bytes: Uint8Array, id: string): string | null {
	const found = rows(sqlite, bytes, `SELECT mode FROM model WHERE id = ${JSON.stringify(id)}`);
	return found.length ? String(found[0][0]) : null;
}

test("an ollama family is published with the mode its own catalogue implies", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	assert.equal(modeOfModel(sqlite, bytes, "ollama/nomic-embed-text"), "embedding");
	assert.equal(modeOfModel(sqlite, bytes, "ollama/granite-embedding"), "embedding");
	assert.equal(modeOfModel(sqlite, bytes, "ollama/qwen3"), "chat");
	// The capabilities and sizes are the page's own pills, and nothing else in
	// the catalogue publishes them.
	const doc = rows(
		sqlite,
		bytes,
		"SELECT doc FROM record_full WHERE source = 'ollama-library' AND source_key = 'qwen3'",
	);
	const record = JSON.parse(String(doc[0][0])) as Record<string, unknown>;
	assert.deepEqual(record.capabilities, ["tools", "thinking"]);
	assert.ok(Array.isArray(record.sizes) && record.sizes.includes("8b"));
});

test("an ollama TAG takes its family's mode, which is what fixes the models people run", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	// bifrost publishes this one as `chat`, with `supports_function_calling`
	// beside it. It is nomic-embed-text at v1.5: it returns a vector.
	assert.equal(modeOfModel(sqlite, bytes, "ollama/nomic-embed-text:v1.5"), "embedding");
	// The tag bifrost already had right stays right...
	assert.equal(modeOfModel(sqlite, bytes, "ollama/granite-embedding:30m"), "embedding");
	// ...and a tag of a chat family is not dragged anywhere by the inheritance.
	// The id is lowercased because every join key is: bifrost publishes this one
	// as `qwen3:8b-q4_K_M`.
	assert.equal(modeOfModel(sqlite, bytes, "ollama/qwen3:8b-q4_k_m"), "chat");
});

test("a source whose whole document is one kind of thing answers for a record that says nothing", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	// crof publishes no `mode` on any of its 21 entries, so before this its
	// models were served as `unknown` -- which the default filter hides. Its
	// page is a chat-model price list: that is a fact about the DOCUMENT, and it
	// settles every entry on it without anything reading a model's NAME.
	assert.equal(modeOfModel(sqlite, bytes, "deepseek-v4-pro-0813"), "chat");
	assert.equal(modeOfModel(sqlite, bytes, "glm-5.2"), "chat");

	const catalogue = new Catalogue(h.sqlite, bytes);
	try {
		const dflt = parseFilter(new URLSearchParams("q=glm-5.2"));
		assert.ok(!("error" in dflt));
		assert.ok(catalogue.returned(dflt) > 0, "and the default view now shows them");
	} finally {
		catalogue.close();
	}
});

test("a stated mode still outranks what a source says its document is", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	// The default answers for a record NOTHING gave a mode. It must never
	// overwrite one: ollama-library says `chat`, and codellama is a base model
	// litellm states `completion` for.
	assert.equal(modeOfModel(sqlite, bytes, "ollama/codellama"), "completion");
	// And a source that publishes many kinds of thing cannot answer at all, so a
	// record with no mode from one of those stays `unknown` rather than becoming
	// something plausible.
	const unknown = rows(
		sqlite,
		bytes,
		"SELECT id FROM model WHERE mode = 'unknown' AND sources NOT LIKE '%crof%'",
	);
	assert.ok(unknown.length > 0, "unknown is still reachable, and still means unknown");
});

test("a family the page states no mode for keeps the mode its own source stated", async () => {
	const h = await harness();
	const { bytes, sqlite } = await built(h);
	// ollama-library outranks every other source on an ollama key, so a `chat`
	// it assumed would silently overwrite this. litellm says `completion` and
	// means it: codellama is a base model you complete with, not converse with.
	// Correcting the embedding models by flattening these would have traded one
	// blanket label for another.
	assert.equal(modeOfModel(sqlite, bytes, "ollama/codellama"), "completion");
	// A family nothing else lists at all is still something you run and talk to,
	// and that reading is made where nothing can inherit it (ingest's modeFor).
	assert.equal(modeOfModel(sqlite, bytes, "ollama/openhermes"), "chat");
});

test("the corrected models are served, and the default view hides the embedding ones", async () => {
	const h = await harness();
	const { bytes } = await built(h);
	const catalogue = new Catalogue(h.sqlite, bytes);
	try {
		const all = parseFilter(new URLSearchParams("mode=all&q=nomic-embed-text"));
		assert.ok(!("error" in all));
		assert.ok(catalogue.returned(all) >= 2, "the family and its tag are both in the catalogue");

		// mode=embedding is how a caller asks for something to embed with, and
		// before this source it answered with none of ollama's.
		const embedding = parseFilter(new URLSearchParams("mode=embedding&provider=ollama"));
		assert.ok(!("error" in embedding));
		assert.ok(catalogue.returned(embedding) >= 4, "ollama's embedding models are findable as such");

		const dflt = parseFilter(new URLSearchParams("q=nomic-embed-text"));
		assert.ok(!("error" in dflt));
		assert.equal(catalogue.returned(dflt), 0, "an embedding model is not something to chat with");
	} finally {
		catalogue.close();
	}
});

test("a listing page that stops naming capabilities degrades loudly, and the rest still builds", async () => {
	const page = fs.readFileSync(fixtureFile({ name: "ollama-library" }), "utf8");
	const source = SOURCES.find((s) => s.name === "ollama-library")!;
	const h = await harness({
		fetcher: fixtureFetcher({
			[source.url]: () =>
				new Response(page.replaceAll("text-indigo-600", "text-violet-600"), {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		}),
	});
	const { bytes } = await built(h);
	const catalogue = new Catalogue(h.sqlite, bytes);
	try {
		assert.deepEqual(catalogue.degraded(), ["ollama-library"]);
		const report = catalogue.sources(h.now!(), 3600).find((s) => s.name === "ollama-library");
		assert.match(String(report?.error), /pill/);
		assert.equal(report?.models, 0);
		assert.ok(catalogue.total() > 10, "the other sources still produce a catalogue");
	} finally {
		catalogue.close();
	}
});

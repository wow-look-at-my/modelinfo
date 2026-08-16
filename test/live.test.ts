import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { build } from "../src/build.ts";
import { memoryStore } from "../src/cache.ts";
import { applyFilter, DEFAULT_MODES, modeOf, parseFilter } from "../src/filter.ts";
import { SOURCES } from "../src/sources.ts";

/**
 * A build against captured copies of all four live documents.
 *
 * The fixtures are real bodies, trimmed to a few hundred models each -- see
 * test/fixtures/README.md. They exist because the merge rules are about how
 * FOUR REAL SOURCES disagree, and a hand-written stub agrees with itself.
 */
const FIXTURES = path.join(import.meta.dirname, "fixtures");

function fixtureFetcher(): typeof fetch {
	const byUrl = new Map(SOURCES.map((s) => [s.url, `${FIXTURES}/${s.name}.json`]));
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		const file = byUrl.get(url);
		if (!file) throw new Error(`no fixture for ${url}`);
		return new Response(fs.readFileSync(file, "utf8"), { status: 200 });
	}) as unknown as typeof fetch;
}

async function fixtureBuild() {
	return build({
		waitUntil: () => {},
		fetcher: fixtureFetcher(),
		store: memoryStore(),
	});
}

test("all four sources merge into one catalogue", async () => {
	const catalogue = await fixtureBuild();
	assert.deepEqual(catalogue.degraded, []);
	assert.equal(catalogue.reports.length, 4);
	for (const report of catalogue.reports) {
		assert.equal(report.error, null, report.name);
		assert.ok(report.models > 0, `${report.name} contributed nothing`);
	}
	assert.ok(catalogue.models.length > 0);
});

test("one model carries what every source said about it", async () => {
	const catalogue = await fixtureBuild();
	const id = catalogue.index.get("gpt-5.2");
	assert.equal(id, "openai/gpt-5.2", "the bare litellm key resolves to the canonical id");

	const model = catalogue.models.find((m) => m.id === id);
	assert.ok(model);
	// All four saw this model, under two different spellings.
	assert.deepEqual(model.sources, [
		"openrouter",
		"bifrost-datasheet",
		"bifrost-parameters",
		"litellm",
	]);
	assert.deepEqual(model.aliases, ["gpt-5.2", "openai/gpt-5.2"]);

	// OpenRouter's strings and litellm's numbers, in one vocabulary.
	assert.equal(model.pricing.prompt, "0.00000175");
	assert.equal(model.pricing.completion, "0.000014");
	assert.equal(model.pricing.input_cache_read, "0.000000175");

	// Each source's own field names survive beside the unified pricing.
	assert.equal(model.max_input_tokens, 272000);
	assert.equal(model.supports_function_calling, true);
	assert.ok(Array.isArray(model.model_parameters), "the parameter schema is carried through");
	assert.ok(Array.isArray(model.supported_parameters), "so is OpenRouter's parameter list");
});

test("the default filter drops image and voice models, and says how many", async () => {
	const catalogue = await fixtureBuild();
	const filter = parseFilter(new URLSearchParams());
	assert.ok(!("error" in filter));
	assert.deepEqual(filter.modes, [...DEFAULT_MODES]);

	const { models, excluded } = applyFilter(catalogue.models, filter);
	assert.ok(excluded > 0, "the fixtures contain gimmicks to exclude");
	assert.ok(models.length > 0);
	for (const model of models) {
		assert.ok(
			(DEFAULT_MODES as readonly string[]).includes(modeOf(model)),
			`${model.id} is ${modeOf(model)}`,
		);
	}
	// The variants that share one base_model are exactly what the default hides.
	assert.ok(!models.some((m) => m.id.includes("1024-x-1024")));
});

test("asking for every mode brings the gimmicks back", async () => {
	const catalogue = await fixtureBuild();
	const filter = parseFilter(new URLSearchParams("mode=all"));
	assert.ok(!("error" in filter));

	const { models, excluded } = applyFilter(catalogue.models, filter);
	assert.equal(excluded, 0);
	assert.equal(models.length, catalogue.models.length);
	assert.ok(models.some((m) => modeOf(m) === "image_generation"));
});

test("a provider filter and a substring filter narrow the list", async () => {
	const catalogue = await fixtureBuild();

	const byProvider = parseFilter(new URLSearchParams("provider=anthropic&mode=all"));
	assert.ok(!("error" in byProvider));
	const anthropic = applyFilter(catalogue.models, byProvider).models;
	assert.ok(anthropic.length > 0);
	for (const m of anthropic) assert.equal(m.owned_by, "anthropic");

	const byQuery = parseFilter(new URLSearchParams("q=opus&mode=all"));
	assert.ok(!("error" in byQuery));
	for (const m of applyFilter(catalogue.models, byQuery).models) {
		assert.ok(
			m.id.includes("opus") || m.aliases.some((a) => a.toLowerCase().includes("opus")),
			m.id,
		);
	}
});

test("an unknown query parameter is refused rather than ignored", () => {
	const got = parseFilter(new URLSearchParams("modes=chat"));
	assert.ok("error" in got);
	assert.match(got.error, /unknown parameter "modes"/);
});

test("a source that fails degrades the answer loudly and never empties it", async () => {
	const working = fixtureFetcher();
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).includes("openrouter")) throw new Error("connection reset");
		return working(input as string, init);
	}) as unknown as typeof fetch;

	const catalogue = await build({ waitUntil: () => {}, fetcher, store: memoryStore() });
	assert.deepEqual(catalogue.degraded, ["openrouter"]);
	assert.ok(catalogue.models.length > 0, "three sources still make a catalogue");

	const report = catalogue.reports.find((r) => r.name === "openrouter");
	assert.ok(report);
	assert.match(report.error ?? "", /connection reset/);
});

test("every source failing is an error, never an empty list", async () => {
	const fetcher = (async () => {
		throw new Error("the internet is gone");
	}) as unknown as typeof fetch;
	await assert.rejects(
		() => build({ waitUntil: () => {}, fetcher, store: memoryStore() }),
		/every source failed/,
	);
});

test("a source serving an error page is an error, not zero models", async () => {
	const fetcher = (async () =>
		new Response("<html>502 Bad Gateway</html>", { status: 200 })) as unknown as typeof fetch;
	await assert.rejects(
		() => build({ waitUntil: () => {}, fetcher, store: memoryStore() }),
		/every source failed/,
	);
});

test("litellm's sample_spec is documentation, and is not a model", async () => {
	const catalogue = await fixtureBuild();
	assert.equal(catalogue.index.get("sample_spec"), undefined);
	assert.ok(!catalogue.models.some((m) => m.aliases.includes("sample_spec")));
});

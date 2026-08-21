import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	familyOf,
	ollamaFamilies,
	ollamaLibraryRecords,
	statedMode,
	type OllamaFamily,
} from "../src/ollama.ts";
import { SOURCES } from "../src/sources.ts";
import { fixtureFile } from "./helpers.ts";

/**
 * The fixture is a real slice of https://ollama.com/library -- the page's own
 * markup, not a hand-written stand-in. Six families, chosen for what they prove:
 *
 *   nomic-embed-text    an embedding family whose tags bifrost calls `chat`
 *   granite-embedding   the one embedding family bifrost already gets right
 *   qwen3               tools + thinking, and eight parameter-size pills
 *   gemma3n             sizes `e2b`/`e4b`, which read as capabilities to anything
 *                       classifying a pill by the shape of its text
 *   gemma4              four capabilities, and the cyan `cloud` pill that is not
 *                       one of them
 *   openhermes          no pills at all
 */
const PAGE = fs.readFileSync(fixtureFile({ name: "ollama-library" }), "utf8");

function familiesByName(): Map<string, OllamaFamily> {
	return new Map([...ollamaFamilies(PAGE)].map((f) => [f.name, f]));
}

function recordsByKey(html = PAGE): Map<string, Record<string, unknown>> {
	return new Map(
		[...ollamaLibraryRecords(html)].map(([key, raw]) => [
			key,
			JSON.parse(raw) as Record<string, unknown>,
		]),
	);
}

test("the source is wired to the transcriber, not to the split path", () => {
	const source = SOURCES.find((s) => s.name === "ollama-library");
	assert.ok(source, "ollama-library is a source");
	assert.equal(source.transcriber, "ollama-library");
	assert.equal(source.htmlAnchor, "", "there is no JSON array on the page to anchor on");
	assert.ok(
		source.priority < SOURCES.find((s) => s.name === "bifrost-parameters")!.priority,
		"ollama's own catalogue outranks a source that calls every ollama model chat",
	);
});

test("a capability pill is read, and a size pill is not mistaken for one", () => {
	const families = familiesByName();
	assert.deepEqual(families.get("qwen3")!.capabilities, ["tools", "thinking"]);
	assert.deepEqual(families.get("qwen3")!.sizes, [
		"0.6b", "1.7b", "4b", "8b", "14b", "30b", "32b", "235b",
	]);
	// The pills that broke a text-shape reader: a mixture-of-experts size and an
	// effective-parameter size are not words, but they are not capabilities.
	assert.deepEqual(families.get("gemma3n")!.capabilities, []);
	assert.deepEqual(families.get("gemma3n")!.sizes, ["e2b", "e4b"]);
	// `cloud` says ollama also hosts this family. It is not a capability of the
	// weights, and it must not arrive as one.
	assert.deepEqual(families.get("gemma4")!.capabilities, ["vision", "tools", "thinking", "audio"]);
	assert.deepEqual(families.get("openhermes")!.capabilities, []);
});

test("the description is the page's own sentence, with its escapes decoded", () => {
	const families = familiesByName();
	assert.equal(
		families.get("nomic-embed-text")!.description,
		"A high-performing open embedding model with a large token context window.",
	);
	for (const family of families.values()) {
		assert.ok(!family.description.includes("&#"), `${family.name} kept a numeric entity`);
		assert.ok(!family.description.includes("<"), `${family.name} kept markup`);
	}
});

test("an embedding family is stated to be one, and nothing else is given a mode", () => {
	const records = recordsByKey();
	assert.equal(records.get("nomic-embed-text")!.mode, "embedding");
	assert.equal(records.get("granite-embedding")!.mode, "embedding");
	// vision, tools, thinking and audio are all ways of holding a conversation,
	// and this source is the lowest-priority one for every ollama key: a `chat`
	// asserted here would beat litellm's stated `completion` on the eight ollama
	// base models that really do complete rather than converse.
	for (const name of ["gemma4", "qwen3", "gemma3n", "openhermes"]) {
		assert.ok(!("mode" in records.get(name)!), `${name} was given a mode it does not state`);
	}
	for (const record of records.values()) assert.equal(record.provider, "ollama");
});

test("statedMode reads the pills, and reads nothing into their absence", () => {
	assert.equal(statedMode(["tools", "embedding"]), "embedding");
	assert.equal(statedMode(["vision", "tools", "thinking", "audio"]), null);
	assert.equal(statedMode([]), null);
	assert.equal(statedMode(undefined), null);
	assert.equal(statedMode("embedding"), null, "a string is not a pill list");
});

test("a page with no capability pill FAILS rather than publishing 235 chat models", () => {
	// The exact failure this guards: ollama restyles the listing, every family
	// still parses, and every embedding model silently reads `chat` again --
	// with the source reporting a healthy build. A source that throws is named
	// in `degraded` and answers 503 on /health instead.
	const restyled = PAGE.replaceAll("text-indigo-600", "text-violet-600");
	assert.throws(() => [...ollamaLibraryRecords(restyled)], /not one .* pill/);
});

test("a page with no family links FAILS rather than reporting an empty catalogue", () => {
	assert.throws(() => [...ollamaLibraryRecords("<html><body>maintenance</body></html>")], /no .* links/);
});

test("familyOf splits a tag off an id, and leaves a family alone", () => {
	assert.equal(familyOf("ollama/nomic-embed-text:v1.5"), "ollama/nomic-embed-text");
	assert.equal(familyOf("ollama/snowflake-arctic-embed:110m-m-fp16"), "ollama/snowflake-arctic-embed");
	assert.equal(familyOf("ollama/qwen3"), null);
	assert.equal(familyOf(":leading"), null);
});

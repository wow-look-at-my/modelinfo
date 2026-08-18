import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { entries, extractEmbeddedArray, items, splitTopLevel } from "../src/split.ts";
import { SOURCES } from "../src/sources.ts";
import { fixtureFile } from "./helpers.ts";

/**
 * The split replaces JSON.parse on the ingest path, so the bar is agreement with
 * JSON.parse -- not "looks right". Anything less and the service is built on a
 * guess about where a value ends.
 */
test("every fixture splits into exactly what JSON.parse sees", () => {
	for (const source of SOURCES) {
		const text = fs.readFileSync(fixtureFile(source), "utf8");
		let expected: [string, unknown][];
		if (source.htmlAnchor) {
			// crof's "document" is HTML; the truth is the array embedded in it.
			const truth = JSON.parse(extractEmbeddedArray(text, source.htmlAnchor)) as unknown[];
			expected = truth.map((v) => ["", v]);
		} else {
			const truth = JSON.parse(text) as Record<string, unknown>;
			expected = source.envelope
				? (truth[source.envelope] as unknown[]).map((v) => ["", v])
				: Object.entries(truth);
		}

		const got = [...splitTopLevel(text, source.envelope, source.htmlAnchor)];
		assert.equal(got.length, expected.length, `${source.name} record count`);
		got.forEach(([key, raw], i) => {
			assert.equal(key, expected[i][0], `${source.name} key #${i}`);
			assert.deepEqual(JSON.parse(raw), expected[i][1], `${source.name} value #${i} (${key})`);
		});
	}
});

test("structure inside a string never ends a value early", () => {
	const cases: unknown[] = [
		{ a: { s: '}{[]"\\' } },
		{ "k\\": { v: "ends with a backslash \\" } },
		{ "éA": { v: 1 } },
		{ a: {}, b: [], c: "" },
		{ a: 1, b: -2.5e-7, c: true, d: false, e: null },
		{ a: [{ b: [{ c: [1, 2, {}] }] }] },
		{ '{":,}': { v: [] } },
	];
	for (const value of cases) {
		for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
			const got = Object.fromEntries([...entries(text)].map(([k, r]) => [k, JSON.parse(r)]));
			assert.deepEqual(got, value, text.slice(0, 60));
		}
	}
});

test("a malformed document throws rather than yielding a truncated record", () => {
	for (const bad of [
		'{"a": {"b": 1}',
		'{"a" 1}',
		"[1,2]",
		'{"a": }',
		'{"a": {"b": "unterminated}',
		'{"a": 1,}',
	]) {
		assert.throws(() => [...entries(bad)], `should reject ${bad}`);
	}
});

test("an enveloped document without its envelope is an error, not an empty list", () => {
	assert.throws(() => [...items('{"models":[]}', "data")], /no "data" member/);
});

test("empty containers yield nothing rather than one empty record", () => {
	assert.deepEqual([...entries("{}")], []);
	assert.deepEqual([...items("[]")], []);
	assert.deepEqual([...items('{"data":[]}', "data")], []);
});

test("extractEmbeddedArray pulls a JSON array out of HTML by its anchor", () => {
	// A real slice of crof's pricing page: the array is inlined in a <script>
	// after `const allModels = `, with other JS around it. The extractor must
	// find the array by its anchor and stop at its OWN closing bracket, not the
	// `betaModels`/`visionModels` arrays that follow it.
	const html = `<html><body><script src="/ui/crofui.js"></script>
		<script>
			const isLoggedIn = false;
			const allModels = [{"id":"a","speed":83,"pricing":{"prompt":"0.35"}}, {"id":"b","speed":77}];
			const betaModels = ["x", "y"];
			const visionModels = ["b"];
		</script></body></html>`;
	const array = extractEmbeddedArray(html, "const allModels = ");
	const got = [...items(array, "")].map((raw) => JSON.parse(raw));
	assert.deepEqual(got, [
		{ id: "a", speed: 83, pricing: { prompt: "0.35" } },
		{ id: "b", speed: 77 },
	]);
	// The extracted text is itself valid JSON, so the rest of the split path
	// (which only JSON.parses slices) sees what the page published.
	assert.deepEqual(JSON.parse(array), got);
});

test("a missing array anchor is an error, not an empty array", () => {
	// A page that dropped the anchor is a broken source, and "no models" would
	// make a redesign look like a quiet day -- the ingest path reports it.
	assert.throws(() => extractEmbeddedArray("<script>const models = [];</script>", "const allModels = "), /no "const allModels = " anchor/);
	assert.throws(() => extractEmbeddedArray("const allModels = {};", "const allModels = "), /not followed by an array/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { entries, items, splitTopLevel } from "../src/split.ts";
import { SOURCES } from "../src/sources.ts";
import { FIXTURES } from "./helpers.ts";

/**
 * The split replaces JSON.parse on the ingest path, so the bar is agreement with
 * JSON.parse -- not "looks right". Anything less and the service is built on a
 * guess about where a value ends.
 */
test("every fixture splits into exactly what JSON.parse sees", () => {
	for (const source of SOURCES) {
		const text = fs.readFileSync(path.join(FIXTURES, `${source.name}.json`), "utf8");
		const truth = JSON.parse(text) as Record<string, unknown>;
		const expected: [string, unknown][] = source.envelope
			? (truth[source.envelope] as unknown[]).map((v) => ["", v])
			: Object.entries(truth);

		const got = [...splitTopLevel(text, source.envelope)];
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

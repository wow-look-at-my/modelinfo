/**
 * Splitting a source document into its records WITHOUT building an object graph.
 *
 * The reason is memory. bifrost-parameters is 18 MB of JSON and `JSON.parse` of
 * it costs 28 MB of live objects on top of the 18 MB of text -- and the database
 * being filled from it occupies WASM memory in the same 128 MB isolate. Ingest
 * never needs the whole document: it needs each record's key, its provider, and
 * its bytes. So this walks the text once and hands back RAW SLICES, and the
 * caller parses one ~2 KB record at a time.
 *
 * A slice is a substring, which V8 represents as a view onto the text rather
 * than a copy, so the split itself allocates almost nothing.
 *
 * This is not a JSON parser and does not try to be one. It finds structure -- it
 * never interprets a value. Anything it hands back still goes through
 * `JSON.parse`, which is what actually validates it. What this must get right is
 * where one value ends, and that is decided by three things: quoting, escaping,
 * and nesting depth.
 */

/** Where a malformed document is reported, naming the offset so it is findable. */
class SplitError extends Error {
	constructor(what: string, text: string, at: number) {
		const near = JSON.stringify(text.slice(Math.max(0, at - 20), at + 20));
		super(`${what} at offset ${at}, near ${near}`);
		this.name = "SplitError";
	}
}

/**
 * entries walks a top-level JSON OBJECT and yields each `key -> raw value text`.
 * This is the shape three of the four sources publish.
 */
export function* entries(text: string): Generator<[string, string]> {
	let i = skipWs(text, 0);
	if (text[i] !== "{") throw new SplitError("expected an object", text, i);
	i = skipWs(text, i + 1);
	if (text[i] === "}") return;

	for (;;) {
		if (text[i] !== '"') throw new SplitError("expected a key", text, i);
		const keyEnd = endOfString(text, i);
		// JSON.parse of the quoted slice, so \n, \" and \uXXXX are one rule
		// rather than three this file gets to reimplement.
		const key = JSON.parse(text.slice(i, keyEnd)) as string;
		i = skipWs(text, keyEnd);
		if (text[i] !== ":") throw new SplitError("expected ':'", text, i);
		i = skipWs(text, i + 1);
		const valueEnd = endOfValue(text, i);
		yield [key, text.slice(i, valueEnd)];
		i = skipWs(text, valueEnd);
		if (text[i] === ",") {
			i = skipWs(text, i + 1);
			continue;
		}
		if (text[i] === "}") return;
		throw new SplitError("expected ',' or '}'", text, i);
	}
}

/**
 * items walks a top-level JSON ARRAY, or the array under `envelope` in a
 * top-level object, and yields each element's raw text. OpenRouter publishes
 * `{"data":[...]}`, so the envelope is `data` there.
 */
export function* items(text: string, envelope = ""): Generator<string> {
	let i = skipWs(text, 0);
	if (envelope) {
		for (const [key, raw] of entries(text)) {
			if (key === envelope) {
				yield* items(raw);
				return;
			}
		}
		throw new Error(`the document has no ${JSON.stringify(envelope)} member`);
	}
	if (text[i] !== "[") throw new SplitError("expected an array", text, i);
	i = skipWs(text, i + 1);
	if (text[i] === "]") return;

	for (;;) {
		const valueEnd = endOfValue(text, i);
		yield text.slice(i, valueEnd);
		i = skipWs(text, valueEnd);
		if (text[i] === ",") {
			i = skipWs(text, i + 1);
			continue;
		}
		if (text[i] === "]") return;
		throw new SplitError("expected ',' or ']'", text, i);
	}
}

function skipWs(text: string, at: number): number {
	let i = at;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		// space, tab, newline, carriage return -- JSON's entire whitespace set.
		if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
		i++;
	}
	return i;
}

/**
 * endOfString returns the index just past the closing quote of the string that
 * STARTS at `at`. A quote closes only when an even number of backslashes
 * precedes it, which is what `\\"` versus `\"` turns on.
 */
function endOfString(text: string, at: number): number {
	let i = at + 1;
	while (i < text.length) {
		const c = text[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === '"') return i + 1;
		i++;
	}
	throw new SplitError("unterminated string", text, at);
}

/** endOfValue returns the index just past the value that STARTS at `at`. */
function endOfValue(text: string, at: number): number {
	const first = text[at];
	if (first === '"') return endOfString(text, at);
	if (first === "{" || first === "[") return endOfContainer(text, at);
	if (first === undefined) throw new SplitError("expected a value", text, at);

	// A scalar runs to the first character that can only belong to the
	// structure around it. Whether the run is a valid number, `true`, `false` or
	// `null` is JSON.parse's judgement, not this file's.
	let i = at;
	while (i < text.length) {
		const c = text[i];
		if (c === "," || c === "}" || c === "]" || c === " " || c === "\t" || c === "\n" || c === "\r") {
			break;
		}
		i++;
	}
	if (i === at) throw new SplitError("expected a value", text, at);
	return i;
}

/**
 * endOfContainer counts nesting, ignoring every brace and bracket inside a
 * string. Skipping strings wholesale is what makes a `"}"` in a description
 * harmless.
 */
function endOfContainer(text: string, at: number): number {
	let depth = 0;
	let i = at;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			i = endOfString(text, i);
			continue;
		}
		if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) return i + 1;
			if (depth < 0) throw new SplitError("unbalanced brackets", text, i);
		}
		i++;
	}
	throw new SplitError("unterminated object or array", text, at);
}

/**
 * The smallest field worth holding once rather than per record. Below this the
 * row in `blob` and the reference replacing the value cost about what the value
 * cost, and every lookup is a join for nothing.
 */
const WORTH_EXTRACTING = 512;

/** A field lifted out of a record, and the record with a reference in its place. */
export interface Extracted {
	/** The record, with `field`'s value replaced by {"$blob": 0}. */
	doc: string;
	/** The field lifted out, or null when nothing was worth lifting. */
	field: string | null;
	/** Its value, verbatim. */
	value: string | null;
}

/**
 * extractLargest lifts a record's biggest object-valued field out of it.
 *
 * This is normalization, not compression: bifrost-parameters repeats 532
 * distinct `model_parameters` schemas across 9,934 models, and holding each copy
 * costs 14.6 MB of a database that has to fit, with SQLite's own working memory,
 * inside a 128 MB isolate.
 *
 * ONE field, the largest. Measured on the real documents, the largest
 * object-valued field carries 99.7% of the repeated bytes, and one field is what
 * a single `json_set` in the record_full view can put back -- a variable number
 * of them is not expressible as a view, and a view is what makes the downloaded
 * database usable without this code.
 *
 * The field name must be a plain identifier, because the view addresses it as
 * '$.' || field and a name containing a dot or a quote would address something
 * else. Anything else stays inline, which is always correct and merely larger.
 */
export function extractLargest(raw: string): Extracted {
	const fields = [...entries(raw)];
	let at = -1;
	for (let i = 0; i < fields.length; i++) {
		const [key, value] = fields[i];
		if (value.length < WORTH_EXTRACTING) continue;
		const first = value[0];
		if (first !== "{" && first !== "[") continue;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		if (at < 0 || value.length > fields[at][1].length) at = i;
	}
	if (at < 0) return { doc: raw, field: null, value: null };

	// Rebuilt rather than spliced, so the marker sits exactly where the field was
	// and the remaining values are still the source's own bytes.
	const parts = fields.map(([key, value], i) =>
		`${JSON.stringify(key)}:${i === at ? '{"$blob":0}' : value}`,
	);
	return { doc: `{${parts.join(",")}}`, field: fields[at][0], value: fields[at][1] };
}

/**
 * extractEmbeddedArray finds a `[...]` JSON array embedded in a larger document
 * (HTML wrapping a JS literal) and returns its raw text, anchored on the string
 * that immediately precedes it.
 *
 * crof.ai has no API, so its pricing page inlines `const allModels = [...]`
 * inside a `<script>`. This finds that array by its anchor and hands back the
 * bytes between the balanced brackets, so the rest of the split path treats it
 * as a bare array without knowing it came out of HTML. A missing anchor or a
 * non-array after it is an ERROR, not an empty document: a page that moved the
 * array is a broken source, and "no models" would make a redesign look like a
 * quiet day.
 */
export function extractEmbeddedArray(text: string, anchor: string): string {
	const at = text.indexOf(anchor);
	if (at < 0) throw new SplitError(`no ${JSON.stringify(anchor)} anchor`, text, 0);
	let i = skipWs(text, at + anchor.length);
	if (text[i] !== "[") {
		throw new SplitError(`${JSON.stringify(anchor)} is not followed by an array`, text, at);
	}
	const end = endOfContainer(text, i);
	return text.slice(i, end);
}

/**
 * splitTopLevel is the one call ingest makes: `key -> raw record text` for
 * either document shape. An enveloped source has no key of its own, so the
 * caller reads the id out of the record it just parsed. An HTML-embedded source
 * (crof) is the same -- the array is pulled out of the page first, then split
 * as a bare array.
 */
export function* splitTopLevel(
	text: string,
	envelope = "",
	htmlAnchor = "",
): Generator<[string, string]> {
	if (htmlAnchor) {
		const array = extractEmbeddedArray(text, htmlAnchor);
		for (const raw of items(array, "")) yield ["", raw];
		return;
	}
	if (envelope) {
		for (const raw of items(text, envelope)) yield ["", raw];
		return;
	}
	yield* entries(text);
}

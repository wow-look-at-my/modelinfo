/**
 * Transcribing ollama.com/library, which publishes no JSON at all.
 *
 * This is the one source whose records do not exist as bytes anywhere. crof's
 * page at least inlines a JSON array, so `split.ts` can hand that array's own
 * bytes on unchanged; ollama's library is server-rendered markup, and what this
 * service needs -- which families embed -- is carried by a coloured `<span>`.
 * So this file READS the page and WRITES a record, which is why it is not in
 * `split.ts`: that file finds structure and never interprets a value, and every
 * line below interprets one.
 *
 * Why the page is worth transcribing at all: it is the only source that knows.
 * bifrost labels 6,308 of its 6,321 `ollama` keys `chat`, embedding models
 * included, and litellm's 29 ollama entries are all chat or completion. So
 * `ollama/nomic-embed-text:v1.5` -- a model whose entire purpose is to return a
 * vector -- was published as something you send a conversation to. See
 * `docs/ollama.md`.
 */

/** Each family is a link to its own page; the name is the last path segment. */
const FAMILY = 'href="/library/';

/**
 * The row of pills under a family's description. Its members are the only
 * per-family facts the listing page carries beyond the description.
 */
const PILL_ROW = 'class="flex flex-wrap space-x-2"';

/** The description, which sits between the title and the pill row. */
const DESCRIPTION = 'class="max-w-lg break-words text-neutral-800 text-md">';

const SPAN = /<span\b([^>]*)>([^<]*)<\/span>/g;

/**
 * A pill is classified by the colour class the page itself gives it, not by the
 * shape of its text.
 *
 * The page draws capabilities indigo and parameter sizes blue, and that is its
 * own distinction rather than one this file invents. Reading sizes off their
 * text instead -- `8b`, `1.7b` -- looks equivalent and is not: it puts `8x7b`,
 * `e2b` and `128x17b` in with the capabilities, which is exactly what the first
 * draft of this did. A third colour (cyan) marks the families ollama also hosts
 * in its cloud; that is a fact about ollama's hosting rather than about the
 * weights, so it is read and not carried.
 */
const CAPABILITY_PILL = "text-indigo-600";
const SIZE_PILL = "text-blue-600";

/** The capability that decides a family is not something you chat with. */
const EMBEDDING = "embedding";

/** One family, as the listing page describes it. */
export interface OllamaFamily {
	name: string;
	description: string;
	/** Indigo pills: `tools`, `thinking`, `vision`, `embedding`, `audio`. */
	capabilities: string[];
	/** Blue pills: the parameter sizes this family publishes tags for. */
	sizes: string[];
}

/**
 * ollamaFamilies walks the listing page once and yields what it says about each
 * family.
 *
 * A page with no family links, or with families but no capability pill
 * anywhere, THROWS. Both are the same failure -- the markup this reads has
 * moved -- and both would otherwise be silent: every family would arrive
 * without capabilities, every embedding model would go back to reading `chat`,
 * and the build would report a healthy source. A source that fails is named in
 * `degraded` and answers 503 on `/health`, which is the outcome a moved page
 * has earned.
 */
export function* ollamaFamilies(html: string): Generator<OllamaFamily> {
	let found = 0;
	let capabilities = 0;
	let at = html.indexOf(FAMILY);
	while (at >= 0) {
		const nameAt = at + FAMILY.length;
		const nameEnd = html.indexOf('"', nameAt);
		if (nameEnd < 0) throw new Error("ollama-library: an unterminated /library/ link");
		const name = html.slice(nameAt, nameEnd).trim();
		const next = html.indexOf(FAMILY, nameEnd);
		// A family's block runs to the next family's link, so a pill row belongs
		// to the family whose link most recently preceded it.
		const block = html.slice(nameEnd, next < 0 ? html.length : next);
		at = next;
		if (!name || name.includes("/")) continue; // a sub-path, not a family
		found++;

		const family: OllamaFamily = {
			name,
			description: descriptionIn(block),
			capabilities: [],
			sizes: [],
		};
		for (const [classes, text] of pillsIn(block)) {
			if (classes.includes(CAPABILITY_PILL)) family.capabilities.push(text);
			else if (classes.includes(SIZE_PILL)) family.sizes.push(text);
		}
		capabilities += family.capabilities.length;
		yield family;
	}

	if (found === 0) throw new Error(`ollama-library: no ${JSON.stringify(FAMILY)} links on the page`);
	if (capabilities === 0) {
		throw new Error(
			`ollama-library: ${found} families and not one ${JSON.stringify(CAPABILITY_PILL)} pill;` +
				" the capability markup moved, and without it no ollama model can be told from another",
		);
	}
}

function* pillsIn(block: string): Generator<[string, string]> {
	const rowAt = block.indexOf(PILL_ROW);
	if (rowAt < 0) return;
	// The row holds spans and nothing else, so its first closing tag ends it.
	const rowEnd = block.indexOf("</div>", rowAt);
	const row = block.slice(rowAt, rowEnd < 0 ? block.length : rowEnd);
	for (const match of row.matchAll(SPAN)) {
		const text = decodeEntities(match[2]).trim();
		if (text) yield [match[1], text];
	}
}

function descriptionIn(block: string): string {
	const at = block.indexOf(DESCRIPTION);
	if (at < 0) return "";
	const start = at + DESCRIPTION.length;
	const end = block.indexOf("<", start);
	return decodeEntities(block.slice(start, end < 0 ? block.length : end)).trim();
}

const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * decodeEntities turns the page's escapes back into text. The live page uses
 * `&#39;`, `&#43;` and `&amp;`; the rest are here because a description is prose
 * and prose acquires punctuation. An entity this does not know is left alone,
 * which is visible in the answer rather than lost.
 */
function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
		}
		if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
		return NAMED[body.toLowerCase()] ?? whole;
	});
}

/**
 * ollamaLibraryRecords is what ingest reads: `family name -> record text`, the
 * same pair shape `splitTopLevel` yields for every other source.
 *
 * `mode` is written ONLY where a pill states one, which today means only
 * `embedding`. This source is the lowest-priority one for every `ollama/*` key,
 * so anything it writes here wins outright -- and a `chat` it merely assumed
 * would beat litellm's stated `completion` on the eight ollama base models that
 * really do complete rather than converse. It knows one thing the others do
 * not; writing more than that turns a correction into a second blanket label.
 * What a family with no such pill IS, is decided in `ingest.ts` (`modeFor`).
 */
export function* ollamaLibraryRecords(html: string): Generator<[string, string]> {
	for (const family of ollamaFamilies(html)) {
		const record: Record<string, unknown> = { provider: "ollama" };
		const mode = statedMode(family.capabilities);
		if (mode) record.mode = mode;
		record.capabilities = family.capabilities;
		record.sizes = family.sizes;
		if (family.description) record.description = family.description;
		yield [family.name, JSON.stringify(record)];
	}
}

/**
 * The capability pills that name a mode. `tools`, `thinking`, `vision` and
 * `audio` are all ways of holding a conversation and name none. A pill for a
 * modality that is not a conversation -- a rerank, say -- has to be added here;
 * nothing detects one on its own, which is the cost of only ever asserting what
 * the page prints.
 */
const MODES: Record<string, string> = { [EMBEDDING]: EMBEDDING };

/** The mode the library page states for a family, or null when it states none. */
export function statedMode(capabilities: unknown): string | null {
	if (!Array.isArray(capabilities)) return null;
	for (const capability of capabilities) {
		if (typeof capability === "string" && MODES[capability]) return MODES[capability];
	}
	return null;
}

/**
 * familyOf is the family part of an ollama model id, or null when the id names
 * a family already.
 *
 * A tag is a quantization or a parameter count of one family's weights --
 * `nomic-embed-text:v1.5`, `snowflake-arctic-embed:110m-m-fp16` -- and nothing
 * about a tag changes what the model DOES. So a family the library page marks
 * `embedding` settles the mode of every tag under it, which is the only way the
 * 37 tagged embedding rows in bifrost get corrected: those tags have no record
 * of their own on ollama.com, and nothing else in the catalogue knows.
 */
export function familyOf(joinKey: string): string | null {
	const tag = joinKey.indexOf(":");
	return tag > 0 ? joinKey.slice(0, tag) : null;
}

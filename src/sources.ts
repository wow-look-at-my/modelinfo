/**
 * The six upstreams, and the order they win ties in.
 *
 * PRECEDENCE. The lowest priority owns a field; a later source fills gaps and
 * never overwrites. So this list is a ruling, not a convenience:
 *
 *   0 openrouter          a live marketplace, and the only source publishing
 *                         cache-write rates per model alongside the parameters a
 *                         model actually accepts today.
 *   1 ollama-library      ollama's own catalogue, and the only source that knows
 *                         which of its models embed. It lists nothing else, so
 *                         this rank governs `ollama/*` and no other key.
 *   2 bifrost-datasheet   the litellm table plus `provider` and `base_model`.
 *   3 bifrost-parameters  the same table again, plus each model's parameter
 *                         schema; it lists about 2.5x more keys than the
 *                         datasheet.
 *   4 litellm             upstream of the two above, and the fallback when
 *                         either has not picked a change up yet.
 *   5 crof                a routing provider with no public API; its pricing page
 *                         inlines an `allModels` array in HTML. It is the only
 *                         source publishing per-model `speed` (tok/s),
 *                         `cache_rate`, and `quantization`, and the only one
 *                         whose prices are per MILLION tokens -- see rateScale.
 */
export interface Source {
	name: string;
	url: string;
	/** Lower wins a field. Stored on every row, so the fold needs no lookup table. */
	priority: number;
	/**
	 * The member holding an array of records, for a document that is not itself
	 * keyed by model. Empty means the top-level object's keys ARE the model keys
	 * (unless `htmlAnchor` is set, in which case the array is embedded in HTML).
	 */
	envelope: string;
	/** The field carrying the id, for an enveloped or HTML-embedded array. */
	idField: string;
	/** Top-level keys that are not models. */
	skip: string[];
	/**
	 * Anchor text immediately preceding an embedded JSON array, for a source
	 * whose document is HTML wrapping a JS literal rather than JSON (crof). Empty
	 * means the body is JSON. The split path finds this string, then the balanced
	 * `[...]` after it; a page that dropped the anchor is a broken source, not a
	 * quiet day.
	 */
	htmlAnchor: string;
	/**
	 * The divisor taking a source's published rates into USD-per-token, the unit
	 * unified `pricing` speaks. crof publishes per MILLION tokens, so its rates
	 * divide by 1e6 at fold time. 1 (the default) leaves a source's rates as it
	 * wrote them. The stored `doc` keeps the source's own values verbatim; only
	 * the merged `pricing` is scaled.
	 */
	rateScale: number;
	/**
	 * The rate names inside a source's nested `pricing` object, when that object
	 * mixes rates with other metadata. crof keeps a `discount` and `*_original`
	 * fields beside its rates; only the names listed here are per-token rates,
	 * and the rest survive as the source's own fields rather than polluting
	 * `pricing`. Empty means every member of `pricing` is a rate (OpenRouter).
	 */
	rateFields: string[];
	/**
	 * The name of a bespoke transcriber for a source whose records are not JSON
	 * anywhere in its document -- today only `ollama-library`, whose facts live
	 * in server-rendered markup. Empty means the split path reads the document,
	 * which is the case for every source that publishes JSON. See `ollama.ts`
	 * for why this is not a `htmlAnchor` and cannot be.
	 */
	transcriber: string;
}

export const SOURCES: Source[] = [
	{
		name: "openrouter",
		url: "https://openrouter.ai/api/v1/models",
		priority: 0,
		envelope: "data",
		idField: "id",
		skip: [],
		htmlAnchor: "",
		rateScale: 1,
		rateFields: [],
		transcriber: "",
	},
	{
		// ollama publishes no API for its library, and no other source knows
		// which of its models embed: bifrost calls 6,308 of its 6,321 ollama
		// keys `chat`. The listing page carries a capability pill per family,
		// so it is read as markup -- see ollama.ts and docs/ollama.md.
		name: "ollama-library",
		url: "https://ollama.com/library",
		priority: 1,
		envelope: "",
		idField: "",
		skip: [],
		htmlAnchor: "",
		rateScale: 1,
		rateFields: [],
		transcriber: "ollama-library",
	},
	{
		name: "bifrost-datasheet",
		url: "https://getbifrost.ai/datasheet",
		priority: 2,
		envelope: "",
		idField: "",
		skip: [],
		htmlAnchor: "",
		rateScale: 1,
		rateFields: [],
		transcriber: "",
	},
	{
		name: "bifrost-parameters",
		url: "https://getbifrost.ai/datasheet/model-parameters",
		priority: 3,
		envelope: "",
		idField: "",
		skip: [],
		htmlAnchor: "",
		rateScale: 1,
		rateFields: [],
		transcriber: "",
	},
	{
		name: "litellm",
		url: "https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json",
		priority: 4,
		envelope: "",
		idField: "",
		// sample_spec is litellm's documentation of its own schema, checked into
		// the same map as if it were a model. It is not one.
		skip: ["sample_spec"],
		htmlAnchor: "",
		rateScale: 1,
		rateFields: [],
		transcriber: "",
	},
	{
		// crof.ai has no public API (`/pricing_api` answers 401); the only public
		// source is the inline `const allModels = [...]` array in the pricing
		// page's HTML. Its ids carry no provider prefix, so its models join on
		// their bare keys and are mostly NEW catalogue entries rather than merges.
		name: "crof",
		url: "https://crof.ai/pricing",
		priority: 5,
		envelope: "",
		idField: "id",
		skip: [],
		htmlAnchor: "const allModels = ",
		// crof publishes prices per million tokens; the rest of the catalogue is
		// per token, so rates divide by 1e6 at fold time (merge.ts).
		rateScale: 1_000_000,
		// crof's `pricing` object mixes rates with a `discount` and `*_original`
		// fields; only these three are per-token rates.
		rateFields: ["prompt", "completion", "cache_prompt"],
		transcriber: "",
	},
];

/** Merge order, by name. */
export const SOURCE_ORDER: string[] = [...SOURCES]
	.sort((a, b) => a.priority - b.priority)
	.map((s) => s.name);

/**
 * The per-source rate config `foldRecords` needs: the divisor into USD-per-token
 * and the set of rate names inside a nested `pricing` object. foldRecords looks
 * it up by source name rather than holding a copy of SOURCES, so merge stays
 * decoupled from the source list's order. An unknown source gets the identity
 * config (no scaling, every `pricing` member a rate), which is the behavior the
 * four JSON sources already rely on.
 */
export interface RateConfig {
	rateScale: number;
	rateFields: Set<string>;
}

const RATE_CONFIG_BY_NAME = new Map<string, RateConfig>(
	SOURCES.map((s) => [s.name, { rateScale: s.rateScale, rateFields: new Set(s.rateFields) }]),
);

export function rateConfig(name: string): RateConfig {
	return RATE_CONFIG_BY_NAME.get(name) ?? { rateScale: 1, rateFields: new Set() };
}

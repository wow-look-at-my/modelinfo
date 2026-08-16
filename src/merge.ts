import type { Model } from "./types.ts";

/**
 * One source's contribution: a flat map of source-key -> that source's record.
 * Every source is reduced to this before merging, so merge.ts never learns four
 * document shapes.
 */
export interface SourceRecords {
	name: string;
	records: Map<string, Record<string, unknown>>;
}

/**
 * MERGE ORDER. The first source to supply a FIELD owns it; later sources fill
 * gaps and never overwrite. So this list is a precedence ruling, not a
 * convenience:
 *
 *   openrouter          a live marketplace, and the only source that publishes
 *                       cache-write rates per model alongside the parameters a
 *                       model actually accepts today.
 *   bifrost-datasheet   the litellm table plus `provider` and `base_model`.
 *   bifrost-parameters  the same table again, plus each model's parameter
 *                       schema; it lists ~2.5x more keys than the datasheet.
 *   litellm             upstream of the two above, and the fallback when
 *                       either has not picked a change up yet.
 */
export const SOURCE_ORDER = [
	"openrouter",
	"bifrost-datasheet",
	"bifrost-parameters",
	"litellm",
] as const;

/**
 * Rate fields, mapped onto the names OpenRouter uses.
 *
 * The unified `pricing` object is the one place a consumer has to look, and it
 * speaks one vocabulary. Each source's own spelling survives untouched beside
 * it -- nothing is dropped -- so a caller that wants
 * `cache_creation_input_token_cost_above_1hr` by name still finds it.
 */
const RATE_ALIASES: Record<string, string> = {
	input_cost_per_token: "prompt",
	output_cost_per_token: "completion",
	cache_read_input_token_cost: "input_cache_read",
	cache_creation_input_token_cost: "input_cache_write",
	cache_creation_input_token_cost_above_1hr: "input_cache_write_1h",
	input_cost_per_audio_token: "audio",
	output_cost_per_audio_token: "audio_output",
	input_cost_per_image: "image",
	output_cost_per_image: "image_output",
	input_cost_per_token_batches: "prompt_batch",
	output_cost_per_token_batches: "completion_batch",
	input_cost_per_token_priority: "prompt_priority",
	output_cost_per_token_priority: "completion_priority",
	cache_read_input_token_cost_priority: "input_cache_read_priority",
	input_cost_per_request: "request",
};

/**
 * rateString renders a rate the way OpenRouter publishes one: a plain decimal
 * string, USD per token.
 *
 * Plain decimal rather than JavaScript's default, because Number.toString gives
 * "1.75e-7" and a consumer reading these as text should not have to handle two
 * spellings of one number. A negative is REFUSED rather than clamped: it is not
 * a price, and a wrong number in a money column is worse than a missing one.
 */
export function rateString(v: unknown): string | null {
	if (typeof v === "string") {
		const trimmed = v.trim();
		const parsed = Number(trimmed);
		return trimmed !== "" && Number.isFinite(parsed) && parsed >= 0 ? trimmed : null;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
	return expand(String(v));
}

/**
 * expand rewrites `1.75e-7` as `0.000000175`, and leaves everything else alone.
 *
 * It works from Number.toString's own digits, which are the shortest that read
 * back as the same double. toFixed is NOT usable here: it prints the binary
 * value's true decimal expansion, so `(0.01).toFixed(20)` is
 * "0.01000000000000000021" and the trailing junk is not trailing zeros to trim.
 */
function expand(s: string): string {
	const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
	if (!m) return s;
	const [, sign, intPart, fracPart = "", expPart] = m;
	const digits = intPart + fracPart;
	const point = intPart.length + Number(expPart);

	if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
	if (point >= digits.length) return sign + digits + "0".repeat(point - digits.length);
	return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

export function lower(s: string): string {
	return s.trim().toLowerCase();
}

/**
 * declaredProvider is the vendor a record names, or the one its key implies.
 *
 * OpenRouter states no provider field at all -- its ids ARE `vendor/model` --
 * so the key's own first segment is the answer there, and it is the same string
 * the other sources put in `provider`.
 */
export function declaredProvider(key: string, record: Record<string, unknown>): string {
	for (const field of ["provider", "litellm_provider", "owned_by"]) {
		const v = record[field];
		if (typeof v === "string" && v.trim()) return lower(v);
	}
	const cut = key.indexOf("/");
	return cut > 0 ? lower(key.slice(0, cut)) : "";
}

/**
 * joinKey is what decides two records describe the same model. It is
 * `provider/name`, where `name` is the source's key with its OWN provider
 * prefix removed -- and nothing else removed.
 *
 * That one rule is what merges litellm's `gpt-5.2` (litellm_provider openai)
 * with OpenRouter's `openai/gpt-5.2`, while keeping every neighbour apart:
 *
 *   - `azure/gpt-4` stays separate from `openai/gpt-4`. Same weights, different
 *     bill.
 *   - `high/1024-x-1024/gpt-image-1.5` stays separate from `gpt-image-1.5`:
 *     `high/` is not the provider, so nothing is stripped. Nineteen priced
 *     variants share one `base_model`, which is exactly why base_model is NOT
 *     the join key -- using it would collapse them onto one wrong price.
 *   - a dated snapshot stays separate from the floating name, because no date
 *     is ever stripped. Providers price those differently often enough that
 *     guessing is worse than two records.
 *
 * A record naming no provider joins on its bare key, which is the most this can
 * honestly say about it.
 */
export function joinKey(key: string, record: Record<string, unknown>): string {
	const k = lower(key);
	const provider = declaredProvider(key, record);
	if (!provider) return k;
	const prefix = provider + "/";
	const name = k.startsWith(prefix) ? k.slice(prefix.length) : k;
	return name ? provider + "/" + name : k;
}

/**
 * bareName is the short name a caller is most likely to ask by, so
 * `anthropic/claude-opus-5` also answers to `claude-opus-5`. It is registered
 * only when exactly one model claims it -- see buildIndex.
 */
export function bareName(key: string): string | null {
	const cut = key.lastIndexOf("/");
	if (cut < 0 || cut === key.length - 1) return null;
	return lower(key.slice(cut + 1));
}

/** Fields this service owns, which a source may never write. */
const RESERVED = new Set(["id", "object", "aliases", "sources", "pricing"]);

/**
 * mergeSources folds every source into one record per model.
 *
 * A field is written once, by the earliest source in SOURCE_ORDER that has it.
 * `pricing` is the exception: it is assembled from every source, first writer
 * per RATE, so a model OpenRouter prices for prompt and completion still picks
 * up a cache-write rate only litellm published.
 */
export function mergeSources(sources: SourceRecords[]): Map<string, Model> {
	const out = new Map<string, Model>();
	for (const source of [...sources].sort((a, b) => order(a.name) - order(b.name))) {
		mergeInto(out, source);
	}
	finish(out);
	return out;
}

/**
 * mergeInto folds ONE source into an accumulator, so a caller can parse a
 * source, fold it, and drop the parsed document before parsing the next.
 *
 * That is not a style preference. Holding all four parsed at once peaked at
 * 140 MB, and a Worker isolate is capped at 128 MB. The caller is responsible
 * for feeding sources in SOURCE_ORDER; mergeSources does it for the simple case.
 */
export function mergeInto(out: Map<string, Model>, source: SourceRecords): void {
	for (const [rawKey, record] of source.records) {
		const key = joinKey(rawKey, record);
		if (!key) continue;

		let model = out.get(key);
		if (!model) {
			model = {
				id: key,
				object: "model",
				created: 0,
				owned_by: declaredProvider(rawKey, record),
				pricing: {},
				aliases: [],
				sources: [],
			};
			out.set(key, model);
		}
		if (!model.sources.includes(source.name)) model.sources.push(source.name);
		if (!model.aliases.includes(rawKey)) model.aliases.push(rawKey);
		if (!model.owned_by) model.owned_by = declaredProvider(rawKey, record);
		if (!model.created && typeof record.created === "number") model.created = record.created;

		for (const [field, value] of Object.entries(record)) {
			if (value === null || value === undefined || RESERVED.has(field)) continue;
			if (!(field in model)) model[field] = value;

			const rateName = RATE_ALIASES[field];
			if (rateName && !(rateName in model.pricing)) {
				const rate = rateString(value);
				if (rate !== null) model.pricing[rateName] = rate;
			}
		}

		// A source already speaking the pricing vocabulary hands it over whole.
		const published = record.pricing;
		if (published && typeof published === "object" && !Array.isArray(published)) {
			for (const [name, value] of Object.entries(published as Record<string, unknown>)) {
				if (name in model.pricing) continue;
				const rate = rateString(value);
				if (rate !== null) model.pricing[name] = rate;
			}
		}
	}
}

/** finish is the once-per-build tidy: alias order, so two builds match byte for byte. */
export function finish(out: Map<string, Model>): void {
	for (const model of out.values()) model.aliases.sort();
}

function order(name: string): number {
	const at = (SOURCE_ORDER as readonly string[]).indexOf(name);
	// A source nobody declared merges last rather than silently first.
	return at < 0 ? SOURCE_ORDER.length : at;
}

/**
 * buildIndex maps every name a caller might use onto one canonical id.
 *
 * Three tiers, and the order between them is the whole point. A canonical id
 * always wins. A name a SOURCE actually used beats a name this service derived.
 * A name two models claim at the same tier is DROPPED, never resolved to
 * whichever came first: an ambiguous lookup that silently picks one model
 * prices a call against the wrong one, and "not found" is the honest answer.
 *
 * That tiering is what keeps `gpt-image-1.5` resolving to OpenAI's model. It is
 * a literal litellm key, so it outranks the nineteen size-and-quality variants
 * that merely share it as a derived `base_model`.
 */
export function buildIndex(models: Map<string, Model>): Map<string, string> {
	const index = new Map<string, string>();

	const tier = (names: (model: Model, id: string) => Iterable<string>) => {
		const taken = new Map<string, string>();
		const ambiguous = new Set<string>();
		for (const model of models.values()) {
			for (const name of names(model, model.id)) {
				const k = lower(name);
				if (!k || index.has(k) || ambiguous.has(k)) continue;
				const held = taken.get(k);
				if (held === undefined) taken.set(k, model.id);
				else if (held !== model.id) {
					taken.delete(k);
					ambiguous.add(k);
				}
			}
		}
		for (const [k, id] of taken) index.set(k, id);
	};

	for (const [key, model] of models) index.set(key, model.id);
	tier((model) => model.aliases);
	tier(function* (model) {
		for (const field of ["canonical_slug", "base_model", "hugging_face_id"]) {
			const v = model[field];
			if (typeof v === "string" && v.trim()) yield v;
		}
		for (const alias of model.aliases) {
			const bare = bareName(alias);
			if (bare) yield bare;
		}
		const bare = bareName(model.id);
		if (bare) yield bare;
	});
	return index;
}

/** sortModels orders by id, so two builds of the same data are byte-identical. */
export function sortModels(models: Map<string, Model>): Model[] {
	return [...models.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

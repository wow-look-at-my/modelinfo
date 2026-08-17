import { rateConfig } from "./sources.ts";
import type { Model } from "./types.ts";

/**
 * One stored row: what a single source said about a single model.
 *
 * `doc` is the source's own bytes, verbatim, exactly as ingest sliced them out
 * of the upstream document. It is parsed here and nowhere earlier, so a model is
 * an object graph only for as long as it takes to write it out.
 */
export interface Row {
	joinKey: string;
	source: string;
	priority: number;
	sourceKey: string;
	doc: string;
}

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
 * scaleRate renders a rate divided by `scale` as a plain decimal string, USD
 * per token, by shifting the decimal point on the source's own digits rather
 * than dividing a double.
 *
 * crof publishes "0.35" per MILLION tokens; the unified `pricing` is per token.
 * Dividing the parsed double by 1e6 gives "0.0000008000000000000001" for "0.80",
 * so the point is shifted instead: scaleRate("0.80", 1e6) is "0.00000800",
 * keeping crof's stated precision. A scale of 1 (the default for the other
 * sources) returns rateString unchanged. A non-rate is refused, as rateString
 * refuses it. The stored `doc` is never scaled -- only the merged `pricing` is.
 */
export function scaleRate(v: unknown, scale: number): string | null {
	const base = rateString(v);
	if (base === null) return null;
	if (scale === 1) return base;
	return shiftPoint(base, scale);
}

/**
 * shiftPoint moves a plain decimal string's point LEFT by `log10(divisor)`
 * places, with no exponent and no float artifacts. `divisor` must be a power of
 * ten (1e6 for crof); the source's own digits are preserved, so "8.00" becomes
 * "0.00000800" rather than the "0.000008" a trim would give -- a rate keeps the
 * precision its source claimed.
 */
function shiftPoint(s: string, divisor: number): string {
	const places = Math.round(Math.log10(divisor));
	if (!Number.isInteger(places) || 10 ** places !== divisor) {
		throw new Error(`rate scale ${divisor} is not a power of ten`);
	}
	const neg = s.startsWith("-");
	const body = neg ? s.slice(1) : s;
	const dot = body.indexOf(".");
	const intPart = dot < 0 ? body : body.slice(0, dot);
	const fracPart = dot < 0 ? "" : body.slice(dot + 1);
	const digits = intPart + fracPart;
	const point = intPart.length - places; // index of the point within `digits`
	let out: string;
	if (point <= 0) {
		out = `0.${"0".repeat(-point)}${digits}`;
	} else if (point >= digits.length) {
		out = digits + "0".repeat(point - digits.length);
	} else {
		out = `${digits.slice(0, point)}.${digits.slice(point)}`;
	}
	return (neg ? "-" : "") + out;
}

/**
 * declaredProvider is the vendor a record names, or the one its key implies.
 *
 * OpenRouter states no provider field at all -- its ids ARE `vendor/model` -- so
 * the key's own first segment is the answer there, and it is the same string the
 * other sources put in `provider`.
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
 * `provider/name`, where `name` is the source's key with its OWN provider prefix
 * removed -- and nothing else removed.
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
 *   - a dated snapshot stays separate from the floating name, because no date is
 *     ever stripped. Providers price those differently often enough that
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
 * only when exactly one model claims it -- see the alias table in ingest.ts.
 */
export function bareName(key: string): string | null {
	const cut = key.lastIndexOf("/");
	if (cut < 0 || cut === key.length - 1) return null;
	return lower(key.slice(cut + 1));
}

/** Fields this service owns, which a source may never write. */
const RESERVED = new Set(["id", "object", "aliases", "sources", "pricing"]);

/**
 * foldRecords turns everything the sources said about ONE model into one record.
 *
 * A field is written once, by the lowest-priority source that has it. `pricing`
 * is the exception: it is assembled from every source, first writer per RATE, so
 * a model OpenRouter prices for prompt and completion still picks up a
 * cache-write rate only litellm published.
 *
 * Rows must arrive in priority order. The query that produces them says so
 * (`ORDER BY join_key, priority`), which is also what lets the caller fold one
 * model at a time instead of holding the catalogue.
 */
export function foldRecords(rows: Row[]): Model {
	const model: Model = {
		id: rows[0].joinKey,
		object: "model",
		created: 0,
		owned_by: "",
		pricing: {},
		aliases: [],
		sources: [],
	};

	for (const row of rows) {
		const record = JSON.parse(row.doc) as Record<string, unknown>;
		if (!model.sources.includes(row.source)) model.sources.push(row.source);
		if (!model.aliases.includes(row.sourceKey)) model.aliases.push(row.sourceKey);
		if (!model.owned_by) model.owned_by = declaredProvider(row.sourceKey, record);
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
			// A source may publish in a different unit (crof: per million tokens)
			// and may mix rates with other metadata (crof: a `discount` and
			// `*_original` fields). rateConfig names the rates and the divisor; the
			// non-rates survive as the source's own fields rather than polluting
			// `pricing`. A source with no declared rate fields (OpenRouter) treats
			// every member as a rate, unscaled -- its original behavior.
			const { rateScale, rateFields } = rateConfig(row.source);
			const known = rateFields.size > 0;
			for (const [name, value] of Object.entries(published as Record<string, unknown>)) {
				if (known && !rateFields.has(name)) {
					if (!(name in model)) model[name] = value;
					continue;
				}
				if (name in model.pricing) continue;
				const rate = scaleRate(value, rateScale);
				if (rate !== null) model.pricing[name] = rate;
			}
		}
	}

	model.aliases.sort();
	return model;
}

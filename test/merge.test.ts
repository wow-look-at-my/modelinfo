import assert from "node:assert/strict";
import test from "node:test";
import {
	bareName,
	declaredProvider,
	foldRecords,
	joinKey,
	rateString,
	scaleRate,
	type Row,
} from "../src/merge.ts";

function row(source: string, priority: number, sourceKey: string, doc: unknown): Row {
	return { joinKey: "x", source, priority, sourceKey, doc: JSON.stringify(doc) };
}

test("a rate is a plain decimal string, whatever spelling the source used", () => {
	// Number.toString gives "1.75e-7"; a consumer reading these as text should not
	// have to handle two spellings of one number.
	assert.equal(rateString(1.75e-7), "0.000000175");
	assert.equal(rateString(3e-8), "0.00000003");
	assert.equal(rateString(1.5e21), "1500000000000000000000");
	assert.equal(rateString(0), "0");
	assert.equal(rateString(0.5), "0.5");
	// toFixed would print the binary value's true expansion here, and the trailing
	// digits are not zeros to trim: (0.01).toFixed(20) is "0.01000000000000000021".
	assert.equal(rateString(0.01), "0.01");
	assert.equal(rateString(0.1 + 0.2), "0.30000000000000004");
	// A string rate is kept as the source wrote it.
	assert.equal(rateString("0.0000030"), "0.0000030");
});

test("a rate that is not a price is refused rather than clamped", () => {
	for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "", "  ", "free", null, {}, []]) {
		assert.equal(rateString(bad), null, JSON.stringify(bad));
	}
});

test("scaleRate divides a per-million rate into per-token by shifting the point, not a double", () => {
	// crof publishes "0.35" per million tokens; the unified pricing is per token.
	// Dividing the parsed double by 1e6 gives "0.0000008000000000000001" for
	// "0.80", so the point is shifted on the source's own digits instead.
	assert.equal(scaleRate("0.35", 1_000_000), "0.00000035", "the plan's example");
	assert.equal(scaleRate("0.80", 1_000_000), "0.00000080", "no float artifacts");
	assert.equal(scaleRate("0.01", 1_000_000), "0.00000001");
	assert.equal(scaleRate("0.003", 1_000_000), "0.000000003");
	assert.equal(scaleRate("8.00", 1_000_000), "0.00000800", "source precision preserved");
	assert.equal(scaleRate("10.00", 1_000_000), "0.00001000");
	// A scale of 1 is the other sources: the rate passes through unchanged.
	assert.equal(scaleRate("0.000005", 1), "0.000005");
	assert.equal(scaleRate(1.75e-7, 1), "0.000000175");
	// A non-rate is refused at any scale, as rateString refuses it.
	for (const bad of [-1, "free", null, "", "  "]) {
		assert.equal(scaleRate(bad, 1_000_000), null, JSON.stringify(bad));
	}
});

test("the join key is provider plus the name, with only its own prefix removed", () => {
	// litellm's gpt-5.2 and OpenRouter's openai/gpt-5.2 are one model.
	assert.equal(joinKey("gpt-5.2", { litellm_provider: "openai" }), "openai/gpt-5.2");
	assert.equal(joinKey("openai/gpt-5.2", {}), "openai/gpt-5.2");
	// Same weights, different bill.
	assert.notEqual(joinKey("azure/gpt-5.2", { provider: "azure" }), "openai/gpt-5.2");
	// `high/` is not a provider, so nothing is stripped and the priced variant
	// stays its own model.
	assert.equal(
		joinKey("high/1024-x-1024/gpt-image-1.5", { provider: "openai" }),
		"openai/high/1024-x-1024/gpt-image-1.5",
	);
	// No date is ever stripped: providers price snapshots differently often enough
	// that guessing is worse than two records.
	assert.notEqual(
		joinKey("claude-opus-4-20250514", { litellm_provider: "anthropic" }),
		joinKey("claude-opus-4", { litellm_provider: "anthropic" }),
	);
	// A record naming no provider joins on its bare key.
	assert.equal(joinKey("mystery-model", {}), "mystery-model");
});

test("the provider is what a record declares, or what its key implies", () => {
	assert.equal(declaredProvider("x", { provider: "Azure" }), "azure");
	assert.equal(declaredProvider("x", { litellm_provider: "openai" }), "openai");
	assert.equal(declaredProvider("x", { owned_by: "google" }), "google");
	assert.equal(declaredProvider("anthropic/claude-opus-5", {}), "anthropic");
	assert.equal(declaredProvider("gpt-4", {}), "");
	// Declared beats implied, and the first field in that order wins.
	assert.equal(declaredProvider("azure/gpt-4", { litellm_provider: "openai" }), "openai");
});

test("bareName is the last segment, and nothing when there is no segment", () => {
	assert.equal(bareName("anthropic/claude-opus-5"), "claude-opus-5");
	assert.equal(bareName("a/b/c"), "c");
	assert.equal(bareName("gpt-4"), null);
	assert.equal(bareName("trailing/"), null);
});

test("the first source in priority order owns a field", () => {
	const model = foldRecords([
		row("openrouter", 0, "openai/gpt-5.2", { context_length: 400000, name: "GPT-5.2" }),
		row("litellm", 3, "gpt-5.2", { context_length: 128000, mode: "chat" }),
	]);
	assert.equal(model.context_length, 400000, "the winner keeps its value");
	assert.equal(model.mode, "chat", "and a later source still fills a gap");
	assert.deepEqual(model.sources, ["openrouter", "litellm"]);
	assert.deepEqual(model.aliases, ["gpt-5.2", "openai/gpt-5.2"]);
});

test("pricing is assembled across sources, first writer per rate", () => {
	const model = foldRecords([
		// OpenRouter already speaks the pricing vocabulary.
		row("openrouter", 0, "anthropic/claude-opus-5", {
			pricing: { prompt: "0.000005", completion: "0.000025" },
		}),
		// litellm's own spellings are mapped onto the same names.
		row("litellm", 3, "claude-opus-5", {
			input_cost_per_token: 9e-6,
			output_cost_per_token: 4.5e-5,
			cache_creation_input_token_cost: 6.25e-6,
			cache_read_input_token_cost: 5e-7,
		}),
	]);
	// The rates OpenRouter published win.
	assert.equal(model.pricing.prompt, "0.000005");
	assert.equal(model.pricing.completion, "0.000025");
	// And the cache rates only litellm has are still picked up, which is the
	// entire reason pricing is merged per rate rather than per source.
	assert.equal(model.pricing.input_cache_write, "0.00000625");
	assert.equal(model.pricing.input_cache_read, "0.0000005");
	// Each source's own spelling survives beside the unified names.
	assert.equal(model.input_cost_per_token, 9e-6);
});

test("crof's per-million rates fold into per-token pricing, and its other facts survive", () => {
	// crof publishes prices per MILLION tokens inside a nested `pricing` object,
	// and mixes a `discount` and `*_original` metadata beside the rates. Only the
	// declared rate fields are scaled into unified `pricing`; the metadata
	// survives as crof's own fields, and the page-only `speed`/`quantization`
	// ride through untouched. The joinKey here is what ingest's joinKey() produces
	// for a crof record: the bare id, since crof names no provider.
	const doc = {
		id: "deepseek-v4-pro-0813",
		name: "DeepSeek: DeepSeek V4 Pro 0813",
		created: 1786736315,
		context_length: "1,000,000",
		max_completion_tokens: "131,072",
		cache_rate: 81,
		quantization: "Q8_0",
		reasoning_effort: true,
		custom_reasoning: true,
		speed: 83,
		pricing: {
			prompt: "0.35",
			completion: "0.80",
			cache_prompt: "0.01",
		},
	};
	const model = foldRecords([
		{ joinKey: "deepseek-v4-pro-0813", source: "crof", priority: 4, sourceKey: "deepseek-v4-pro-0813", doc: JSON.stringify(doc) },
	]);
	// Per-million -> per-token (÷1e6), as plain decimal strings.
	assert.equal(model.pricing.prompt, "0.00000035");
	assert.equal(model.pricing.completion, "0.00000080");
	assert.equal(model.pricing.cache_prompt, "0.00000001");
	// The page-only facts the objective names ("tok/s, etc.") survive.
	assert.equal(model.speed, 83);
	assert.equal(model.cache_rate, 81);
	assert.equal(model.quantization, "Q8_0");
	assert.equal(model.reasoning_effort, true);
	// crof joins on its bare id (no provider prefix).
	assert.equal(model.id, "deepseek-v4-pro-0813");
	assert.equal(model.owned_by, "");
	assert.deepEqual(model.aliases, ["deepseek-v4-pro-0813"]);
});

test("crof's pricing metadata is not folded into unified pricing, but survives as its own fields", () => {
	// glm-5.2's `pricing` object carries a `discount` and `*_original` fields
	// beside the rates. The rates scale into `pricing`; the metadata must NOT
	// pollute it, and must not be dropped either.
	const model = foldRecords([
		row("crof", 4, "glm-5.2", {
			id: "glm-5.2",
			pricing: {
				prompt: "0.15",
				completion: "0.52",
				cache_prompt: "0.02",
				prompt_original: "0.30",
				completion_original: "1.05",
				cache_prompt_original: "0.05",
				discount: 50.0,
			},
		}),
	]);
	assert.equal(model.pricing.prompt, "0.00000015");
	assert.equal(model.pricing.completion, "0.00000052");
	assert.equal(model.pricing.cache_prompt, "0.00000002");
	// The metadata did not enter unified pricing...
	assert.ok(!("discount" in model.pricing), JSON.stringify(model.pricing));
	assert.ok(!("prompt_original" in model.pricing), JSON.stringify(model.pricing));
	// ...but it survived as crof's own fields beside it.
	assert.equal(model.discount, 50.0);
	assert.equal(model.prompt_original, "0.30");
	assert.equal(model.completion_original, "1.05");
	assert.equal(model.cache_prompt_original, "0.05");
});

test("a crof rate does not overwrite a rate an earlier source already published", () => {
	// crof is the lowest-priority source, and pricing is first-writer-per-rate.
	// OpenRouter's per-token prompt rate wins; crof only fills a rate OpenRouter
	// did not publish (here, cache_prompt).
	const model = foldRecords([
		row("openrouter", 0, "deepseek/deepseek-v4-pro", {
			pricing: { prompt: "0.00000040", completion: "0.00000090" },
		}),
		row("crof", 4, "deepseek-v4-pro", {
			pricing: { prompt: "0.35", completion: "0.80", cache_prompt: "0.01" },
		}),
	]);
	assert.equal(model.pricing.prompt, "0.00000040", "openrouter's per-token rate wins");
	assert.equal(model.pricing.completion, "0.00000090");
	assert.equal(model.pricing.cache_prompt, "0.00000001", "crof fills the gap, scaled");
});

test("a source may not write the fields this service owns", () => {
	const model = foldRecords([
		row("litellm", 3, "gpt-4", {
			id: "not-this",
			object: "not-this",
			aliases: ["not-this"],
			sources: ["not-this"],
			litellm_provider: "openai",
		}),
	]);
	assert.equal(model.id, "x");
	assert.equal(model.object, "model");
	assert.deepEqual(model.aliases, ["gpt-4"]);
	assert.deepEqual(model.sources, ["litellm"]);
	assert.equal(model.owned_by, "openai");
});

test("a null is not a value, so a later source still gets to answer", () => {
	const model = foldRecords([
		row("openrouter", 0, "openai/gpt-4", { max_tokens: null }),
		row("litellm", 3, "gpt-4", { max_tokens: 8192 }),
	]);
	assert.equal(model.max_tokens, 8192);
});

test("a model no source dated is dated 0, which is what OpenAI sends", () => {
	const model = foldRecords([row("litellm", 3, "gpt-4", { litellm_provider: "openai" })]);
	assert.equal(model.created, 0);
	assert.equal(model.object, "model");
	assert.deepEqual(model.pricing, {});
});

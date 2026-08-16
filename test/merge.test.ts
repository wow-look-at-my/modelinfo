import assert from "node:assert/strict";
import { test } from "node:test";

import {
	bareName,
	buildIndex,
	declaredProvider,
	joinKey,
	mergeSources,
	rateString,
	sortModels,
	type SourceRecords,
} from "../src/merge.ts";

function source(name: string, records: Record<string, Record<string, unknown>>): SourceRecords {
	return { name, records: new Map(Object.entries(records)) };
}

test("a rate is a plain decimal string, never exponential", () => {
	assert.equal(rateString(1.75e-7), "0.000000175");
	assert.equal(rateString(0.000014), "0.000014");
	assert.equal(rateString(0), "0");
	assert.equal(rateString(0.01), "0.01");
	assert.equal(rateString("0.000000175"), "0.000000175");
});

test("a negative rate is refused rather than clamped", () => {
	assert.equal(rateString(-1), null);
	assert.equal(rateString("-0.5"), null);
	assert.equal(rateString(Number.NaN), null);
	assert.equal(rateString("nonsense"), null);
	assert.equal(rateString(""), null);
	assert.equal(rateString(null), null);
});

test("a provider comes from the record, or from the key when the record is silent", () => {
	assert.equal(declaredProvider("gpt-5.2", { litellm_provider: "OpenAI" }), "openai");
	assert.equal(declaredProvider("x", { provider: "anthropic" }), "anthropic");
	// OpenRouter states no provider at all: its ids ARE vendor/model.
	assert.equal(declaredProvider("openai/gpt-5.2", {}), "openai");
	assert.equal(declaredProvider("gpt-5.2", {}), "");
});

test("the join key strips a key's OWN provider prefix and nothing else", () => {
	assert.equal(joinKey("openai/gpt-5.2", {}), "openai/gpt-5.2");
	assert.equal(joinKey("gpt-5.2", { litellm_provider: "openai" }), "openai/gpt-5.2");
	// Same weights, different bill.
	assert.equal(joinKey("azure/gpt-4", { litellm_provider: "azure" }), "azure/gpt-4");
	assert.notEqual(
		joinKey("azure/gpt-4", { litellm_provider: "azure" }),
		joinKey("gpt-4", { litellm_provider: "openai" }),
	);
});

test("a quality or size prefix is not a provider, so priced variants stay apart", () => {
	const variants = [
		"gpt-image-1.5",
		"low/1024-x-1024/gpt-image-1.5",
		"high/1024-x-1536/gpt-image-1.5",
		"medium/1024-x-1024/gpt-image-1.5",
	];
	const keys = variants.map((v) => joinKey(v, { provider: "openai", base_model: "gpt-image-1.5" }));
	assert.equal(new Set(keys).size, variants.length, keys.join(" | "));
});

test("base_model never merges anything, because 19 priced variants share one", () => {
	// $0.009 and $0.200 per image, one base_model. Merging on it would put one
	// of those prices on the other, a 22x error in the money column.
	const merged = mergeSources([
		source("litellm", {
			"low/1024-x-1024/gpt-image-1.5": {
				litellm_provider: "openai",
				base_model: "gpt-image-1.5",
				input_cost_per_image: 0.009,
			},
			"high/1024-x-1536/gpt-image-1.5": {
				litellm_provider: "openai",
				base_model: "gpt-image-1.5",
				input_cost_per_image: 0.2,
			},
		}),
	]);
	assert.equal(merged.size, 2);
	const prices = sortModels(merged).map((m) => m.pricing.image);
	assert.deepEqual(prices, ["0.2", "0.009"]);
});

test("one model out of four sources, first source per field", () => {
	const merged = mergeSources([
		source("litellm", {
			"gpt-5.2": {
				litellm_provider: "openai",
				max_input_tokens: 272000,
				cache_creation_input_token_cost: 0.00001,
				mode: "chat",
			},
		}),
		source("openrouter", {
			"openai/gpt-5.2": {
				name: "GPT-5.2",
				context_length: 400000,
				pricing: { prompt: "0.00000175", completion: "0.000014" },
			},
		}),
		source("bifrost-datasheet", {
			"gpt-5.2": { provider: "openai", max_input_tokens: 111, supports_vision: true },
		}),
	]);

	assert.equal(merged.size, 1);
	const model = [...merged.values()][0];
	assert.equal(model.id, "openai/gpt-5.2");
	assert.equal(model.owned_by, "openai");
	assert.deepEqual(model.aliases, ["gpt-5.2", "openai/gpt-5.2"]);
	// OpenRouter is first in SOURCE_ORDER, so its fields win.
	assert.equal(model.name, "GPT-5.2");
	assert.equal(model.context_length, 400000);
	// bifrost-datasheet outranks litellm on a field both have.
	assert.equal(model.max_input_tokens, 111);
	// A field only litellm has still lands.
	assert.equal(model.supports_vision, true);
	// Pricing is assembled across sources, first writer per RATE: OpenRouter
	// priced the two it knows, litellm supplied the cache write it did not.
	assert.deepEqual(model.pricing, {
		prompt: "0.00000175",
		completion: "0.000014",
		input_cache_write: "0.00001",
	});
	assert.deepEqual(model.sources, ["openrouter", "bifrost-datasheet", "litellm"]);
});

test("a source never overwrites a field an earlier source wrote", () => {
	const merged = mergeSources([
		source("openrouter", { "openai/x": { pricing: { prompt: "0.001" } } }),
		source("litellm", { x: { litellm_provider: "openai", input_cost_per_token: 0.999 } }),
	]);
	assert.equal([...merged.values()][0].pricing.prompt, "0.001");
});

test("the bare name is the last segment, and only when there is one", () => {
	assert.equal(bareName("anthropic/claude-opus-5"), "claude-opus-5");
	assert.equal(bareName("replicate/openai/gpt-image-1.5"), "gpt-image-1.5");
	assert.equal(bareName("gpt-5.2"), null);
	assert.equal(bareName("openai/"), null);
});

test("a name two models claim resolves to neither", () => {
	const merged = mergeSources([
		source("litellm", {
			"openai/gpt-4": { litellm_provider: "openai" },
			"azure/gpt-4": { litellm_provider: "azure" },
		}),
	]);
	const index = buildIndex(merged);
	assert.equal(index.get("openai/gpt-4"), "openai/gpt-4");
	assert.equal(index.get("azure/gpt-4"), "azure/gpt-4");
	// Both claim the bare name. Picking one would price a call against the
	// wrong vendor, so it resolves to nothing.
	assert.equal(index.get("gpt-4"), undefined);
});

test("a literal source key outranks a derived base_model", () => {
	const merged = mergeSources([
		source("litellm", {
			"gpt-image-1.5": { litellm_provider: "openai", base_model: "gpt-image-1.5" },
			"high/1024-x-1024/gpt-image-1.5": {
				litellm_provider: "openai",
				base_model: "gpt-image-1.5",
			},
		}),
	]);
	const index = buildIndex(merged);
	// "gpt-image-1.5" is a key litellm actually used for OpenAI's model, so it
	// beats the same string appearing as a derived base_model on the variant.
	assert.equal(index.get("gpt-image-1.5"), "openai/gpt-image-1.5");
});

test("a model's own id is never displaced by another model's alias", () => {
	const merged = mergeSources([
		source("litellm", {
			"openai/foo": { litellm_provider: "openai" },
			bar: { litellm_provider: "openai", base_model: "foo" },
		}),
	]);
	const index = buildIndex(merged);
	assert.equal(index.get("openai/foo"), "openai/foo");
	assert.equal(index.get("openai/bar"), "openai/bar");
});

test("models sort by id, so two builds of one input are byte-identical", () => {
	const merged = mergeSources([
		source("litellm", { b: { litellm_provider: "z" }, a: { litellm_provider: "z" } }),
	]);
	assert.deepEqual(sortModels(merged).map((m) => m.id), ["z/a", "z/b"]);
});

test("a source nobody declared merges last rather than silently first", () => {
	const merged = mergeSources([
		source("mystery", { "openai/x": { name: "from mystery" } }),
		source("openrouter", { "openai/x": { name: "from openrouter" } }),
	]);
	assert.equal([...merged.values()][0].name, "from openrouter");
});

test("expanding an exponent keeps the digits the double actually round-trips", () => {
	// toFixed would print the binary expansion here and leave junk that is not
	// trailing zeros: (0.01).toFixed(20) is "0.01000000000000000021".
	assert.equal(rateString(0.01), "0.01");
	assert.equal(rateString(0.2), "0.2");
	assert.equal(rateString(0.009), "0.009");
	assert.equal(rateString(0.0000049999999999999996), "0.0000049999999999999996");
	assert.equal(rateString(3.4e-8), "0.000000034");
	assert.equal(rateString(1e21), "1000000000000000000000");
	// Every rendering must read back as the number it came from.
	for (const v of [1.75e-7, 0.01, 0.2, 0.009, 3.4e-8, 2.08333333333333e-8, 0.000014]) {
		assert.equal(Number(rateString(v)), v, String(v));
	}
});

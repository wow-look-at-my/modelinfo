import type { SourceRecords } from "./merge.ts";

export interface Source {
	name: string;
	url: string;
	/** Turns one source document into flat model-key -> record. */
	parse(body: unknown): SourceRecords;
}

/**
 * A document that will not parse into records is an ERROR, never an empty
 * result. An upstream serving an error page and an upstream with nothing to say
 * are different facts, and reporting both as "no models" makes a broken URL look
 * like a quiet day.
 */
function fail(name: string, saw: unknown): never {
	throw new Error(
		`${name}: the document is not the shape this source publishes (saw ${describe(saw)})`,
	);
}

function describe(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `array of ${v.length}`;
	if (typeof v === "object") return `object with ${Object.keys(v as object).length} keys`;
	return typeof v;
}

/** keyedObject is the shape three of the four sources share: model id -> record. */
function keyedObject(name: string, body: unknown, skip: Set<string>): SourceRecords {
	if (!body || typeof body !== "object" || Array.isArray(body)) fail(name, body);
	const records = new Map<string, Record<string, unknown>>();
	for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
		if (skip.has(key)) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		records.set(key, value as Record<string, unknown>);
	}
	if (records.size === 0) fail(name, body);
	return { name, records };
}

export const SOURCES: Source[] = [
	{
		name: "openrouter",
		url: "https://openrouter.ai/api/v1/models",
		parse(body) {
			const data = (body as { data?: unknown })?.data;
			if (!Array.isArray(data) || data.length === 0) fail("openrouter", body);
			const records = new Map<string, Record<string, unknown>>();
			for (const entry of data) {
				const id = (entry as { id?: unknown })?.id;
				if (typeof id === "string" && id) {
					records.set(id, entry as Record<string, unknown>);
				}
			}
			if (records.size === 0) fail("openrouter", body);
			return { name: "openrouter", records };
		},
	},
	{
		name: "bifrost-datasheet",
		url: "https://getbifrost.ai/datasheet",
		parse: (body) => keyedObject("bifrost-datasheet", body, new Set()),
	},
	{
		name: "bifrost-parameters",
		url: "https://getbifrost.ai/datasheet/model-parameters",
		parse: (body) => keyedObject("bifrost-parameters", body, new Set()),
	},
	{
		name: "litellm",
		url:
			"https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json",
		// sample_spec is litellm's documentation of its own schema, checked into
		// the same map as if it were a model. It is not one.
		parse: (body) => keyedObject("litellm", body, new Set(["sample_spec"])),
	},
];

/**
 * The four upstreams, and the order they win ties in.
 *
 * PRECEDENCE. The lowest priority owns a field; a later source fills gaps and
 * never overwrites. So this list is a ruling, not a convenience:
 *
 *   0 openrouter          a live marketplace, and the only source publishing
 *                         cache-write rates per model alongside the parameters a
 *                         model actually accepts today.
 *   1 bifrost-datasheet   the litellm table plus `provider` and `base_model`.
 *   2 bifrost-parameters  the same table again, plus each model's parameter
 *                         schema; it lists about 2.5x more keys than the
 *                         datasheet.
 *   3 litellm             upstream of the two above, and the fallback when
 *                         either has not picked a change up yet.
 */
export interface Source {
	name: string;
	url: string;
	/** Lower wins a field. Stored on every row, so the fold needs no lookup table. */
	priority: number;
	/**
	 * The member holding an array of records, for a document that is not itself
	 * keyed by model. Empty means the top-level object's keys ARE the model keys.
	 */
	envelope: string;
	/** The field carrying the id, for an enveloped document. */
	idField: string;
	/** Top-level keys that are not models. */
	skip: string[];
}

export const SOURCES: Source[] = [
	{
		name: "openrouter",
		url: "https://openrouter.ai/api/v1/models",
		priority: 0,
		envelope: "data",
		idField: "id",
		skip: [],
	},
	{
		name: "bifrost-datasheet",
		url: "https://getbifrost.ai/datasheet",
		priority: 1,
		envelope: "",
		idField: "",
		skip: [],
	},
	{
		name: "bifrost-parameters",
		url: "https://getbifrost.ai/datasheet/model-parameters",
		priority: 2,
		envelope: "",
		idField: "",
		skip: [],
	},
	{
		name: "litellm",
		url: "https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json",
		priority: 3,
		envelope: "",
		idField: "",
		// sample_spec is litellm's documentation of its own schema, checked into
		// the same map as if it were a model. It is not one.
		skip: ["sample_spec"],
	},
];

/** Merge order, by name. */
export const SOURCE_ORDER: string[] = [...SOURCES]
	.sort((a, b) => a.priority - b.priority)
	.map((s) => s.name);

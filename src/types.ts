/** The unified record. One model, everything every source said about it. */
export interface Model {
	/** Canonical id. OpenAI's `/v1/models` calls this `id`. */
	id: string;
	object: "model";
	/** Epoch seconds. Absent upstream means 0, which is what OpenAI sends for a model with no date. */
	created: number;
	/** OpenAI's field for the vendor. */
	owned_by: string;

	/**
	 * Rates as OpenRouter publishes them: DECIMAL STRINGS, USD per token.
	 *
	 * Strings because that is the shape a client reading `/v1/models` already
	 * parses, and because a rate like 3.75e-7 written as a JSON number invites a
	 * float-formatting difference between two encoders. Every numeric rate a
	 * source published is converted into this, so one consumer reads one unit.
	 */
	pricing: Record<string, string>;

	/** Every key, in any source, that resolves to this record. */
	aliases: string[];
	/** Which sources contributed, in merge order. */
	sources: string[];

	/** Everything else each source said, merged. See merge.ts for precedence. */
	[field: string]: unknown;
}

export interface ModelList {
	object: "list";
	data: Model[];
}

/** What one source contributed, and whether it was usable. */
export interface SourceReport {
	name: string;
	url: string;
	/** When the bytes this build used were fetched. */
	fetchedAt: string;
	/** Seconds old at merge time. */
	ageSeconds: number;
	/** Models this source contributed. */
	models: number;
	/** Non-null when the source could not be read at all; its data is absent. */
	error: string | null;
	/** True when the bytes were past their TTL and a refresh was kicked off behind this response. */
	stale: boolean;
}

/**
 * The response envelope. `object`/`data` are exactly OpenAI's `/v1/models`, so a
 * client that knows nothing about this service reads it unchanged; everything
 * this service adds sits beside them under names OpenAI does not use.
 */
export interface Response extends ModelList {
	modelinfo: {
		builtAt: string;
		/** Seconds until this document is refetched by a client honoring Cache-Control. */
		ttlSeconds: number;
		sources: SourceReport[];
		/** Sources that failed. Non-empty means `data` is incomplete, and says so. */
		degraded: string[];
	};
}

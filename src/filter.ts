import type { Model } from "./types.ts";
import { lower } from "./merge.ts";

/**
 * DEFAULT_MODES: the models you send a conversation to.
 *
 * Everything else -- image generation, speech, transcription, video, embedding,
 * rerank, moderation -- is off by default and one query parameter away. A
 * catalogue answering `gpt-image-1.5` to a client looking for something to chat
 * with is a catalogue that has to be filtered by every caller, which means it
 * gets filtered wrongly by some of them.
 *
 * The exclusion is never silent: the response's `modelinfo.filter` states the
 * modes applied and how many records they removed.
 */
export const DEFAULT_MODES = ["chat", "responses", "completion"] as const;

export interface Filter {
	/** Modes to include. Empty means every mode. */
	modes: string[];
	/** Providers to include, lowercased. Empty means every provider. */
	providers: string[];
	/** Substring an id or alias must contain, lowercased. Empty means no test. */
	query: string;
	/** True when the caller asked for every mode rather than taking the default. */
	allModes: boolean;
}

/**
 * parseFilter reads the query string.
 *
 *   ?mode=chat,embedding   these modes
 *   ?mode=all              every mode, gimmicks included
 *   ?provider=openai,...   these vendors
 *   ?q=opus                id or alias contains this
 *
 * An unrecognized parameter is an ERROR rather than a silent no-op: a caller who
 * typed `?modes=chat` and got the default list back would believe a filter ran
 * that never did, and would be reading a wrong catalogue with no way to tell.
 */
export function parseFilter(params: URLSearchParams): Filter | { error: string } {
	const known = new Set(["mode", "provider", "q"]);
	for (const name of params.keys()) {
		if (!known.has(name)) {
			return {
				error: `unknown parameter ${JSON.stringify(name)}; this endpoint takes mode, provider and q`,
			};
		}
	}

	const modeParam = list(params.get("mode"));
	const allModes = modeParam.length === 1 && modeParam[0] === "all";
	return {
		modes: allModes ? [] : modeParam.length ? modeParam : [...DEFAULT_MODES],
		providers: list(params.get("provider")),
		query: lower(params.get("q") ?? ""),
		allModes,
	};
}

function list(raw: string | null): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => lower(s))
		.filter(Boolean);
}

/**
 * modeOf is the model's mode, derived when no source stated one.
 *
 * OpenRouter states no `mode` at all -- everything it lists is something you
 * send a conversation to -- so its output modalities answer instead. A record
 * with neither is `unknown`, which the default filter excludes; it is named in
 * the response rather than dropped quietly, so an upstream that stops labelling
 * its models shows up as a count instead of as models that vanished.
 */
export function modeOf(model: Model): string {
	const stated = model.mode;
	if (typeof stated === "string" && stated.trim()) return lower(stated);

	const arch = model.architecture as { output_modalities?: unknown } | undefined;
	const out = Array.isArray(arch?.output_modalities)
		? (arch.output_modalities as unknown[]).filter((m): m is string => typeof m === "string")
		: [];
	if (out.length) {
		if (out.includes("image")) return "image_generation";
		if (out.includes("audio")) return "audio_speech";
		if (out.includes("video")) return "video_generation";
		if (out.includes("text")) return "chat";
	}
	// OpenRouter lists nothing but conversational models, so one of its records
	// with no modalities block is still one of those.
	if (Array.isArray(model.supported_parameters)) return "chat";
	return "unknown";
}

/** canonicalQuery is the cache key for a filter: same filter, same bytes. */
export function canonicalQuery(filter: Filter): string {
	const parts = [
		`mode=${filter.allModes ? "all" : [...filter.modes].sort().join(",")}`,
		`provider=${[...filter.providers].sort().join(",")}`,
		`q=${filter.query}`,
	];
	return parts.join("&");
}

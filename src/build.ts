import { swrFetch, type SWRStore } from "./cache.ts";
import { Interner } from "./intern.ts";
import { buildIndex, finish, mergeInto, SOURCE_ORDER, sortModels } from "./merge.ts";
import { SOURCES } from "./sources.ts";
import type { Model, SourceReport } from "./types.ts";

/** One hour, for the sources and for the answer alike. */
export const TTL_SECONDS = 3600;

export interface Catalogue {
	models: Model[];
	/** Every name a caller may ask by -> canonical id. */
	index: Map<string, string>;
	reports: SourceReport[];
	/** Sources that could not be read at all. Non-empty means `models` is incomplete. */
	degraded: string[];
	builtAt: Date;
}

export interface BuildOptions {
	waitUntil(promise: Promise<unknown>): void;
	fetcher?: typeof fetch;
	store?: SWRStore;
	now?: () => Date;
	ttlSeconds?: number;
}

/**
 * build reads every source through the SWR cache and merges them.
 *
 * ONE SOURCE AT A TIME, in merge order. That is a memory decision, not a style
 * one: a Worker isolate is capped at 128 MB, the four documents parse to about
 * 34 MB together, and holding all four bodies AND all four parsed documents at
 * once needs 160 MB. Reading them in sequence means the largest thing alive is
 * one document's text plus one document's objects, on top of the accumulator.
 * Depth: docs/memory.md.
 *
 * The cost is four serial round trips on a COLD cache, which happens once per
 * colo per hour at most. A warm or stale read makes no upstream call in front of
 * the response at all, so the common request is unaffected.
 *
 * A source that fails is named in `degraded` and in its own report, and the
 * answer says so rather than quietly shipping a smaller list. A build with NO
 * usable source throws: an empty catalogue served as if it were an answer is the
 * one outcome worse than an error.
 */
export async function build(opts: BuildOptions): Promise<Catalogue> {
	const now = opts.now ?? (() => new Date());
	const ttlSeconds = opts.ttlSeconds ?? TTL_SECONDS;

	const merged = new Map<string, Model>();
	const reports: SourceReport[] = [];
	let usable = 0;
	// One interner for the whole build, so a value litellm and bifrost both
	// publish is held once rather than twice.
	const interner = new Interner();

	for (const source of [...SOURCES].sort((a, b) => rank(a.name) - rank(b.name))) {
		let error: string | null = null;
		let models = 0;
		let fetchedAt = new Date(0);
		let ageSeconds = 0;
		let stale = false;
		try {
			const cached = await swrFetch(source.url, {
				ttlSeconds,
				waitUntil: opts.waitUntil,
				fetcher: opts.fetcher,
				store: opts.store,
				now,
			});
			fetchedAt = cached.fetchedAt;
			ageSeconds = cached.ageSeconds;
			stale = cached.stale;
			// Everything named in this block falls out of scope at the end of it,
			// so the next source's parse starts from one document in memory.
			const records = source.parse(interner.parse(cached.body));
			models = records.records.size;
			mergeInto(merged, records);
			usable++;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		reports.push({
			name: source.name,
			url: source.url,
			fetchedAt: fetchedAt.toISOString(),
			ageSeconds,
			models,
			error,
			stale,
		});
	}

	const degraded = reports.filter((r) => r.error !== null).map((r) => r.name);
	if (usable === 0) {
		throw new Error(
			"every source failed, so there is no catalogue to serve: " +
				reports.map((r) => `${r.name} (${r.error})`).join("; "),
		);
	}

	finish(merged);
	return {
		models: sortModels(merged),
		index: buildIndex(merged),
		reports,
		degraded,
		builtAt: now(),
	};
}

function rank(name: string): number {
	const at = (SOURCE_ORDER as readonly string[]).indexOf(name);
	return at < 0 ? SOURCE_ORDER.length : at;
}

import { swrFetch, type SWRStore } from "./cache.ts";
import { modeOf } from "./filter.ts";
import { bareName, foldRecords, joinKey, lower, type Row } from "./merge.ts";
import { familyOf, ollamaLibraryRecords, statedMode } from "./ollama.ts";
import { SCHEMA } from "./schema.ts";
import { defaultModeOf, SOURCES, type Source } from "./sources.ts";
import { extractLargest, splitTopLevel } from "./split.ts";
import type { Database, Sqlite } from "./sqlite.ts";
import type { Model } from "./types.ts";

/** One hour, for the sources, the database and the answers alike. */
export const TTL_SECONDS = 3600;

export interface IngestOptions {
	sqlite: Sqlite;
	waitUntil(promise: Promise<unknown>): void;
	fetcher?: typeof fetch;
	store?: SWRStore;
	now?: () => Date;
	ttlSeconds?: number;
	/**
	 * Wait for a stale source rather than reading the stale copy. Set when this
	 * build is itself a background rebuild -- see SWROptions.blockUntilFresh.
	 */
	blockUntilFresh?: boolean;
}

/**
 * ingest builds the whole database and returns it as a file.
 *
 * ONE SOURCE AT A TIME, in priority order, and each document is split into raw
 * record slices rather than parsed whole (see split.ts). That is the memory
 * argument: the largest thing alive at any moment is one document's text plus
 * the database being written, and a Worker isolate has 128 MB for both.
 *
 * A source that fails is recorded in the `source` table with its error and
 * contributes no rows. A build with NO usable source THROWS: a database that
 * looks complete and holds nothing is the one outcome worse than an error.
 */
export async function ingest(opts: IngestOptions): Promise<Uint8Array> {
	const now = opts.now ?? (() => new Date());
	const ttlSeconds = opts.ttlSeconds ?? TTL_SECONDS;
	const db = new opts.sqlite.Database();
	try {
		db.run(SCHEMA);
		let usable = 0;
		for (const source of [...SOURCES].sort((a, b) => a.priority - b.priority)) {
			if (await readSource(db, source, { ...opts, now, ttlSeconds })) usable++;
		}
		if (usable === 0) {
			const why = db
				.exec("SELECT name, error FROM source WHERE error IS NOT NULL")
				.flatMap((r) => r.values)
				.map((v) => `${String(v[0])} (${String(v[1])})`)
				.join("; ");
			throw new Error(`every source failed, so there is no catalogue to serve: ${why}`);
		}
		identify(db);
		writeMeta(db, now(), ttlSeconds);
		return db.export();
	} finally {
		db.close();
	}
}

/** True when the source contributed rows. */
async function readSource(
	db: Database,
	source: Source,
	opts: IngestOptions & { now: () => Date; ttlSeconds: number },
): Promise<boolean> {
	let error: string | null = null;
	let records = 0;
	let fetchedAt = new Date(0);

	try {
		const cached = await swrFetch(source.url, {
			ttlSeconds: opts.ttlSeconds,
			waitUntil: opts.waitUntil,
			fetcher: opts.fetcher,
			store: opts.store,
			now: opts.now,
			blockUntilFresh: opts.blockUntilFresh,
		});
		fetchedAt = cached.fetchedAt;
		records = insertRecords(db, source, cached.body);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		records = 0;
	}

	db.run(
		"INSERT INTO source (name, url, priority, fetched_at, records, error) VALUES (?,?,?,?,?,?)",
		[source.name, source.url, source.priority, fetchedAt.toISOString(), records, error],
	);
	return error === null && records > 0;
}

/**
 * insertRecords walks the document and writes one row per model.
 *
 * A document that yields no rows is an ERROR rather than an empty source: an
 * upstream serving an error page and an upstream with nothing to say are
 * different facts, and reporting both as "no models" makes a broken URL look
 * like a quiet day.
 */
function insertRecords(db: Database, source: Source, body: string): number {
	const skip = new Set(source.skip);
	const insert = db.prepare(
		"INSERT INTO record (join_key, source, priority, source_key, doc, field, blob_id) VALUES (?,?,?,?,?,?,?)",
	);
	const putBlob = db.prepare("INSERT OR IGNORE INTO blob (json) VALUES (?)");
	const findBlob = db.prepare("SELECT id FROM blob WHERE json = ?");
	let n = 0;
	db.run("BEGIN");
	try {
		for (const [key, raw] of recordsOf(source, body)) {
			if (skip.has(key)) continue;
			// The ONLY parse in the ingest path, and its subject is one ~2 KB record
			// rather than an 18 MB document.
			const record = JSON.parse(raw) as unknown;
			if (!record || typeof record !== "object" || Array.isArray(record)) continue;
			const fields = record as Record<string, unknown>;
			// An enveloped or HTML-embedded array has no key of its own; the id lives
			// in a field. A bare object's keys ARE the model ids.
			const id = source.envelope || source.htmlAnchor ? String(fields[source.idField] ?? "") : key;
			if (!id) continue;

			const { doc, field, value } = extractLargest(raw);
			let blobId: number | null = null;
			if (value !== null) {
				putBlob.run([value]);
				findBlob.bind([value]);
				blobId = findBlob.step() ? Number(findBlob.get()[0]) : null;
				findBlob.reset();
			}
			insert.run([
				joinKey(id, fields),
				source.name,
				source.priority,
				id,
				blobId === null ? raw : doc,
				blobId === null ? null : field,
				blobId,
			]);
			n++;
		}
		if (n === 0) throw new Error(`${source.name}: the document held no models`);
		db.run("COMMIT");
	} catch (err) {
		// A half-written source must leave nothing behind, or "this source failed"
		// and "this source contributed" would both be true of the same build. There
		// is no rollback journal to undo it with -- see schema.ts -- so the rows go
		// by name. The blob rows it may have added are unreferenced and harmless.
		db.run("COMMIT");
		db.run("DELETE FROM record WHERE source = ?", [source.name]);
		throw err;
	} finally {
		insert.free();
		putBlob.free();
		findBlob.free();
	}
	return n;
}

/**
 * recordsOf yields a source's records as `key -> raw record text`.
 *
 * Almost every source publishes JSON, and `splitTopLevel` hands back the
 * source's own bytes. `ollama-library` publishes markup and no JSON at all, so
 * its records are TRANSCRIBED rather than sliced -- the one place `record.doc`
 * is not an upstream's own bytes, because there are none. The exception is named
 * here, at the seam, rather than hidden inside the split path: see `ollama.ts`.
 */
export function recordsOf(source: Source, body: string): Generator<[string, string]> {
	if (source.transcriber === "ollama-library") return ollamaLibraryRecords(body);
	return splitTopLevel(body, source.envelope, source.htmlAnchor);
}

/**
 * identify fills the `model` and `alias` tables in one ordered pass over
 * `record`, folding each model, recording what a query needs to find it, and
 * dropping the folded value.
 */
function identify(db: Database): void {
	const cursor = db.prepare(
		"SELECT join_key, source, priority, source_key, doc FROM record_full ORDER BY join_key, priority",
	);
	const insert = db.prepare(
		"INSERT INTO model (id, provider, mode, created, sources, prices) VALUES (?,?,?,?,?,?)",
	);
	// Tier is what breaks a name two models both answer to: a name a SOURCE used
	// beats a name this service derived, and a tie inside one tier is dropped
	// rather than resolved. See registerAliases.
	const claims = [new Map<string, string>(), new Map<string, string>()];
	const contested = [new Set<string>(), new Set<string>()];
	// One entry per ollama family, filled as the pass reaches it. See modeFor:
	// this is the whole catalogue-shaped thing identify holds, and the library
	// page lists 235 families, so it is about 10 KB rather than a catalogue.
	const families = new Map<string, string>();

	try {
		db.run("BEGIN");
		let rows: Row[] = [];
		const flush = () => {
			if (rows.length === 0) return;
			const model = foldRecords(rows);
			insert.run([
				model.id,
				lower(String(model.owned_by ?? "")),
				modeFor(model, families),
				model.created,
				model.sources.join(","),
				Object.keys(model.pricing).length,
			]);
			claimNames(claims[0], contested[0], model.id, model.aliases);
			claimNames(claims[1], contested[1], model.id, derivedNames(model.id, model.aliases, rows));
			rows = [];
		};
		while (cursor.step()) {
			const [joinKey, source, priority, sourceKey, doc] = cursor.get() as [
				string,
				string,
				number,
				string,
				string,
			];
			if (rows.length && rows[0].joinKey !== joinKey) flush();
			rows.push({ joinKey, source, priority, sourceKey, doc });
		}
		flush();
		db.run("COMMIT");
	} finally {
		cursor.free();
		insert.free();
	}
	registerAliases(db, claims, contested);
}

/**
 * modeFor is `modeOf`, plus the one thing modeOf cannot see: an ollama TAG's
 * mode is its FAMILY's.
 *
 * `ollama/nomic-embed-text:v1.5` is a quantization of `nomic-embed-text`, and a
 * quantization does not change what a model does. But the tag has no page on
 * ollama.com and no record of its own in any source that knows -- bifrost, the
 * only source listing it, calls it `chat`, as it calls 6,308 of its 6,321
 * ollama keys. So the family answers for it. Without this the fix reaches the
 * 235 family records and none of the 42 tagged embedding rows people actually
 * run.
 *
 * Only a mode the library page STATES is inherited -- `statedMode` reads the
 * family's own capability pills, not the mode it ended up with. Inheriting the
 * latter would push a `chat` this service assumed onto tags whose own source
 * said `completion`, which is the blanket labelling this change exists to undo.
 *
 * The families map is filled by this same pass, which is safe because
 * `ollama/x` is a proper prefix of `ollama/x:tag` and the cursor is ordered by
 * join_key: a family is always folded before any tag under it.
 *
 * A model no source gave a mode at all falls to `defaultModeOf`: what a SOURCE
 * says its whole document is, which is a fact about the document rather than a
 * reading of any model's name. That is what stops crof's 21 chat models and
 * ollama's pill-less families being served as `unknown` and hidden by the
 * default filter. A model no source can answer for stays `unknown`.
 */
function modeFor(model: Model, families: Map<string, string>): string {
	const mode = modeOf(model);
	if (model.id.startsWith("ollama/")) {
		const family = familyOf(model.id);
		if (family !== null) return families.get(family) ?? modeOrDefault(model, mode);
		const stated = statedMode(model.capabilities);
		if (stated) families.set(model.id, stated);
	}
	return modeOrDefault(model, mode);
}

function modeOrDefault(model: Model, mode: string): string {
	if (mode !== "unknown") return mode;
	return defaultModeOf(model.sources) || mode;
}

function claimNames(
	claims: Map<string, string>,
	contested: Set<string>,
	id: string,
	names: Iterable<string>,
): void {
	for (const raw of names) {
		const name = lower(raw);
		if (!name || contested.has(name)) continue;
		const held = claims.get(name);
		if (held === undefined) claims.set(name, id);
		else if (held !== id) {
			claims.delete(name);
			contested.add(name);
		}
	}
}

/** Names this service worked out, as opposed to names a source published. */
function* derivedNames(id: string, aliases: string[], rows: Row[]): Generator<string> {
	for (const row of rows) {
		const record = JSON.parse(row.doc) as Record<string, unknown>;
		for (const field of ["canonical_slug", "base_model", "hugging_face_id"]) {
			const v = record[field];
			if (typeof v === "string" && v.trim()) yield v;
		}
	}
	for (const alias of aliases) {
		const bare = bareName(alias);
		if (bare) yield bare;
	}
	const bare = bareName(id);
	if (bare) yield bare;
}

/**
 * registerAliases writes the lookup table, best claim first.
 *
 * A canonical id always wins. A name a SOURCE used beats a name this service
 * derived. A name two models claim at the same tier is DROPPED, never resolved
 * to whichever came first: an ambiguous lookup that silently picks one model
 * prices a call against the wrong one, and "not found" is the honest answer.
 *
 * That tiering is what keeps `gpt-image-1.5` resolving to OpenAI's model. It is
 * a literal litellm key, so it outranks the nineteen size-and-quality variants
 * that merely share it as a derived `base_model`.
 */
function registerAliases(
	db: Database,
	claims: Map<string, string>[],
	contested: Set<string>[],
): void {
	const insert = db.prepare("INSERT OR IGNORE INTO alias (name, id) VALUES (?,?)");
	try {
		db.run("BEGIN");
		db.run("INSERT OR IGNORE INTO alias (name, id) SELECT id, id FROM model");
		for (let tier = 0; tier < claims.length; tier++) {
			for (const [name, id] of claims[tier]) {
				if (contested[tier].has(name)) continue;
				insert.run([name, id]);
			}
		}
		db.run("COMMIT");
	} finally {
		insert.free();
	}
}

function writeMeta(db: Database, builtAt: Date, ttlSeconds: number): void {
	const rows: [string, string][] = [
		["built_at", builtAt.toISOString()],
		["ttl_seconds", String(ttlSeconds)],
		["source_order", SOURCES.slice().sort((a, b) => a.priority - b.priority).map((s) => s.name).join(",")],
	];
	const insert = db.prepare("INSERT INTO meta (key, value) VALUES (?,?)");
	try {
		for (const row of rows) insert.run(row);
	} finally {
		insert.free();
	}
	db.run(
		"INSERT INTO meta (key, value) SELECT 'models', CAST(COUNT(*) AS TEXT) FROM model",
	);
	db.run(
		"INSERT INTO meta (key, value) SELECT 'records', CAST(COUNT(*) AS TEXT) FROM record",
	);
	db.run(
		"INSERT INTO meta (key, value) SELECT 'aliases', CAST(COUNT(*) AS TEXT) FROM alias",
	);
	db.run(
		"INSERT INTO meta (key, value) SELECT 'degraded', COALESCE(GROUP_CONCAT(name, ','), '') FROM source WHERE error IS NOT NULL",
	);
}

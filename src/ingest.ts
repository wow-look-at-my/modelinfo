import { swrFetch, type SWRStore } from "./cache.ts";
import { modeOf } from "./filter.ts";
import { bareName, foldRecords, joinKey, lower, type Row } from "./merge.ts";
import { SCHEMA } from "./schema.ts";
import { SOURCES, type Source } from "./sources.ts";
import { splitTopLevel } from "./split.ts";
import type { Database, Sqlite } from "./sqlite.ts";

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
		"INSERT INTO record (join_key, source, priority, source_key, doc) VALUES (?,?,?,?,?)",
	);
	let n = 0;
	db.run("BEGIN");
	try {
		for (const [key, raw] of splitTopLevel(body, source.envelope)) {
			if (skip.has(key)) continue;
			// The ONLY parse in the ingest path, and its subject is one ~2 KB
			// record rather than an 18 MB document.
			const record = JSON.parse(raw) as unknown;
			if (!record || typeof record !== "object" || Array.isArray(record)) continue;
			const fields = record as Record<string, unknown>;
			const id = source.envelope ? String(fields[source.idField] ?? "") : key;
			if (!id) continue;
			insert.run([joinKey(id, fields), source.name, source.priority, id, raw]);
			n++;
		}
		if (n === 0) throw new Error(`${source.name}: the document held no models`);
		db.run("COMMIT");
	} catch (err) {
		// A half-written source must leave nothing behind, or "this source failed"
		// and "this source contributed" would both be true of the same build.
		db.run("ROLLBACK");
		throw err;
	} finally {
		insert.free();
	}
	return n;
}

/**
 * identify fills the `model` and `alias` tables in one ordered pass over
 * `record`, folding each model, recording what a query needs to find it, and
 * dropping the folded value.
 */
function identify(db: Database): void {
	const cursor = db.prepare(
		"SELECT join_key, source, priority, source_key, doc FROM record ORDER BY join_key, priority",
	);
	const insert = db.prepare(
		"INSERT INTO model (id, provider, mode, created, sources, prices) VALUES (?,?,?,?,?,?)",
	);
	// Tier is what breaks a name two models both answer to: a name a SOURCE used
	// beats a name this service derived, and a tie inside one tier is dropped
	// rather than resolved. See registerAliases.
	const claims = [new Map<string, string>(), new Map<string, string>()];
	const contested = [new Set<string>(), new Set<string>()];

	try {
		db.run("BEGIN");
		let rows: Row[] = [];
		const flush = () => {
			if (rows.length === 0) return;
			const model = foldRecords(rows);
			insert.run([
				model.id,
				lower(String(model.owned_by ?? "")),
				modeOf(model),
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

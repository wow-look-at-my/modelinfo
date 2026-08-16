import type { Filter } from "./filter.ts";
import { foldRecords, type Row } from "./merge.ts";
import type { Database, Sqlite, SqlValue } from "./sqlite.ts";
import type { Model, SourceReport } from "./types.ts";

/**
 * A read of the ingested database.
 *
 * Everything the service answers comes through here, and none of it assembles
 * the catalogue: a filter is a WHERE clause, a listing is one ordered cursor
 * folded model by model, and a single model is an indexed lookup. The largest
 * value alive while answering `/v1/models` is one model.
 */
export class Catalogue {
	private readonly db: Database;

	constructor(sqlite: Sqlite, bytes: Uint8Array) {
		this.db = new sqlite.Database(bytes);
	}

	close(): void {
		this.db.close();
	}

	meta(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const table of this.db.exec("SELECT key, value FROM meta")) {
			for (const [key, value] of table.values) out[String(key)] = String(value);
		}
		return out;
	}

	/**
	 * Each source's report, with its age measured NOW.
	 *
	 * The database records when a source was fetched, never how old it was; a
	 * database served stale for an hour would otherwise keep reporting the age its
	 * sources had when it was built, which is the one number a caller checking
	 * freshness must not be given.
	 */
	sources(now: Date, ttlSeconds: number): SourceReport[] {
		return this.all(
			"SELECT name, url, fetched_at, records, error FROM source ORDER BY priority",
		).map((v) => {
			const fetchedAt = String(v[2]);
			const ageSeconds = Math.max(
				0,
				Math.round((now.getTime() - new Date(fetchedAt).getTime()) / 1000),
			);
			return {
				name: String(v[0]),
				url: String(v[1]),
				fetchedAt,
				ageSeconds,
				models: Number(v[3]),
				error: v[4] === null ? null : String(v[4]),
				stale: ageSeconds >= ttlSeconds,
			};
		});
	}

	/** Sources that could not be read. Non-empty means every answer is incomplete. */
	degraded(): string[] {
		return this.all("SELECT name FROM source WHERE error IS NOT NULL ORDER BY priority").map((v) =>
			String(v[0]),
		);
	}

	total(): number {
		return Number(this.first("SELECT COUNT(*) FROM model") ?? 0);
	}

	returned(filter: Filter): number {
		const { sql, values } = where(filter);
		return Number(this.first(`SELECT COUNT(*) FROM model m ${sql}`, values) ?? 0);
	}

	/**
	 * list streams the filtered catalogue as OpenAI's `/v1/models` document.
	 *
	 * One cursor, ordered by model then by source priority, folded a model at a
	 * time. The trailer is written last because `returned` is only known once
	 * every row has gone past, and because a client streaming the response should
	 * see `object` and `data` -- the shape it came for -- before anything else.
	 */
	list(filter: Filter, trailer: (returned: number) => unknown): ReadableStream<Uint8Array> {
		const { sql, values } = where(filter);
		const cursor = this.db.prepare(
			`SELECT r.join_key, r.source, r.priority, r.source_key, r.doc
			 FROM record_full r JOIN model m ON m.id = r.join_key
			 ${sql}
			 ORDER BY r.join_key, r.priority`,
		);
		cursor.bind(values);

		const encoder = new TextEncoder();
		let pending: Row[] = [];
		let written = 0;
		let done = false;

		return new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode('{"object":"list","data":['));
			},
			pull(controller) {
				if (done) return;
				// A chunk rather than a model: one enqueue per model over 12k models
				// is 12k round trips through the stream machinery for no gain.
				let chunk = "";
				while (chunk.length < 256 * 1024) {
					if (!cursor.step()) {
						done = true;
						break;
					}
					const [joinKey, source, priority, sourceKey, doc] = cursor.get() as [
						string,
						string,
						number,
						string,
						string,
					];
					if (pending.length && pending[0].joinKey !== joinKey) {
						chunk += (written++ ? "," : "") + JSON.stringify(foldRecords(pending));
						pending = [];
					}
					pending.push({ joinKey, source, priority, sourceKey, doc });
				}
				if (done) {
					if (pending.length) {
						chunk += (written++ ? "," : "") + JSON.stringify(foldRecords(pending));
						pending = [];
					}
					chunk += `],"modelinfo":${JSON.stringify(trailer(written))}}`;
				}
				controller.enqueue(encoder.encode(chunk));
				if (done) {
					cursor.free();
					controller.close();
				}
			},
			cancel() {
				done = true;
				cursor.free();
			},
		});
	}

	/** One model, by any name it answers to. */
	one(name: string): Model | undefined {
		const id = this.resolve(name);
		if (!id) return undefined;
		const rows = this.rowsFor(id);
		return rows.length ? foldRecords(rows) : undefined;
	}

	resolve(name: string): string | undefined {
		const found = this.first("SELECT id FROM alias WHERE name = ?", [
			name.trim().toLowerCase(),
		]);
		return found === undefined || found === null ? undefined : String(found);
	}

	/** Up to ten ids containing the name, so a 404 is actionable. */
	suggest(name: string, limit = 10): string[] {
		const like = `%${name.trim().toLowerCase()}%`;
		return this.all(
			"SELECT DISTINCT id FROM alias WHERE name LIKE ? ORDER BY id LIMIT ?",
			[like, limit],
		).map((r) => String(r[0]));
	}

	private rowsFor(id: string): Row[] {
		return this.all(
			"SELECT join_key, source, priority, source_key, doc FROM record_full WHERE join_key = ? ORDER BY priority",
			[id],
		).map((v) => ({
			joinKey: String(v[0]),
			source: String(v[1]),
			priority: Number(v[2]),
			sourceKey: String(v[3]),
			doc: String(v[4]),
		}));
	}

	private all(sql: string, values: SqlValue[] = []): SqlValue[][] {
		const stmt = this.db.prepare(sql);
		try {
			if (values.length) stmt.bind(values);
			const out: SqlValue[][] = [];
			while (stmt.step()) out.push(stmt.get());
			return out;
		} finally {
			stmt.free();
		}
	}

	private first(sql: string, values: SqlValue[] = []): SqlValue | undefined {
		return this.all(sql, values)[0]?.[0];
	}
}

/**
 * where turns a filter into SQL. Doing it here rather than after the fact is
 * what keeps a `?provider=anthropic` request from folding 12,078 models to
 * answer with 40.
 */
function where(filter: Filter): { sql: string; values: SqlValue[] } {
	const clauses: string[] = [];
	const values: SqlValue[] = [];

	if (filter.modes.length) {
		clauses.push(`m.mode IN (${filter.modes.map(() => "?").join(",")})`);
		values.push(...filter.modes);
	}
	if (filter.providers.length) {
		clauses.push(`m.provider IN (${filter.providers.map(() => "?").join(",")})`);
		values.push(...filter.providers);
	}
	if (filter.query) {
		// An alias row exists for the id itself, so this one test covers both the
		// canonical name and every name a source used for it.
		clauses.push("EXISTS (SELECT 1 FROM alias a WHERE a.id = m.id AND a.name LIKE ?)");
		values.push(`%${filter.query}%`);
	}
	return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

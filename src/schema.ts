/**
 * The database `/db` hands out.
 *
 * It is the INGEST, not the projection: every source's records verbatim, plus
 * the identity a query needs to find them. The merged shape is what
 * `/v1/models` serves, and it is folded from these rows on the way out -- one
 * model at a time, which is why neither this file nor the service ever holds the
 * whole catalogue.
 *
 * Two decisions worth keeping:
 *
 * `record` is a rowid table with a separate index, not WITHOUT ROWID. Putting a
 * 2 KB `doc` in the primary-key b-tree cost overflow pages on every row: the
 * same data measured 53.8 MB that way and 27.5 MB this way.
 *
 * `doc` is the source's own bytes. Not re-serialized, not normalized, not
 * reordered. A caller comparing what this service says against what an upstream
 * says has to be able to see the upstream's own answer.
 */
export const SCHEMA = `
-- No rollback journal. The database is built from nothing in memory and thrown
-- away if the build fails, so a journal only buys the ability to undo a
-- statement -- and it buys it in the same WebAssembly memory the isolate is
-- capped at. A source that fails deletes its own rows instead.
PRAGMA journal_mode = OFF;
-- 8 MB of page cache. The default is counted in PAGES, and the ingest touches
-- every page it writes exactly once, so a large cache holds pages nobody will
-- read again.
PRAGMA cache_size = -8000;

-- fetched_at, and no age: an age recorded at build time is the age the data
-- was THEN, and a reader wants the age it is NOW. The projection subtracts.
CREATE TABLE source (
	name       TEXT PRIMARY KEY,
	url        TEXT NOT NULL,
	priority   INTEGER NOT NULL,
	fetched_at TEXT NOT NULL,
	records    INTEGER NOT NULL,
	error      TEXT
);

-- One large repeated field per record, held once. bifrost-parameters publishes a
-- model_parameters form schema per model, and 9,934 models share 532 distinct
-- ones: 14.6 MB of the document, 1.0 MB of distinct content. Storing each copy
-- is not thrift lost, it is 14 MB of a 128 MB isolate.
CREATE TABLE blob (
	id   INTEGER PRIMARY KEY,
	json TEXT NOT NULL
);
CREATE UNIQUE INDEX blob_json ON blob (json);

-- doc is the source's own record. Its largest object-valued field, if there was
-- one worth holding once, reads {"$blob": N} here and is restored by record_full
-- -- which is the view to query, and the one this service reads.
CREATE TABLE record (
	join_key   TEXT NOT NULL,
	source     TEXT NOT NULL,
	priority   INTEGER NOT NULL,
	source_key TEXT NOT NULL,
	doc        TEXT NOT NULL,
	field      TEXT,
	blob_id    INTEGER REFERENCES blob (id)
);
CREATE INDEX record_join ON record (join_key, priority);

CREATE VIEW record_full AS
SELECT
	r.join_key,
	r.source,
	r.priority,
	r.source_key,
	CASE
		WHEN r.field IS NULL THEN r.doc
		ELSE json_set(r.doc, '$.' || r.field, json(b.json))
	END AS doc
FROM record r LEFT JOIN blob b ON b.id = r.blob_id;

CREATE TABLE model (
	id       TEXT PRIMARY KEY,
	provider TEXT NOT NULL,
	mode     TEXT NOT NULL,
	created  INTEGER NOT NULL,
	sources  TEXT NOT NULL,
	prices   INTEGER NOT NULL
);
CREATE INDEX model_provider ON model (provider);
CREATE INDEX model_mode ON model (mode);

CREATE TABLE alias (
	name TEXT PRIMARY KEY,
	id   TEXT NOT NULL
);
CREATE INDEX alias_id ON alias (id);

CREATE TABLE meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`;

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

CREATE TABLE record (
	join_key   TEXT NOT NULL,
	source     TEXT NOT NULL,
	priority   INTEGER NOT NULL,
	source_key TEXT NOT NULL,
	doc        TEXT NOT NULL
);
CREATE INDEX record_join ON record (join_key, priority);

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

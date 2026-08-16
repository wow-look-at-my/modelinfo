/**
 * SQLite, compiled to WebAssembly, running inside the Worker.
 *
 * Why not D1: D1 cannot hand back its own file. `D1Database.dump()` is
 * documented as working "only on databases created during D1's alpha period", so
 * a database created today can never be served as bytes -- and serving the
 * database as bytes is half of what this service is for. sql.js has
 * `Database.export()`, which is exactly that.
 *
 * Why SQLite at all: the catalogue is 12,078 models and 22 MB of source JSON, and
 * a Worker isolate is capped at 128 MB. SQLite pages are a compact
 * representation of that data and JS objects are not -- holding the same
 * catalogue as objects needed 160 MB. Rows go in one source at a time and come
 * out one query at a time, so neither end of the service ever holds all of it.
 *
 * This file declares only the sql.js surface used here. sql.js ships no types,
 * and a hand-written declaration of the six methods called is checkable against
 * this file; a types package that drifts from the runtime is not.
 */

/** A prepared statement, stepped row by row so a result set is never an array. */
export interface Statement {
	bind(values: SqlValue[]): boolean;
	step(): boolean;
	get(): SqlValue[];
	getAsObject(): Record<string, SqlValue>;
	run(values?: SqlValue[]): void;
	reset(): void;
	free(): boolean;
}

export interface Database {
	run(sql: string, values?: SqlValue[]): void;
	prepare(sql: string): Statement;
	exec(sql: string): { columns: string[]; values: SqlValue[][] }[];
	/** The whole database, as a file. This is what `/db` serves. */
	export(): Uint8Array;
	close(): void;
}

export type SqlValue = string | number | Uint8Array | null;

export interface Sqlite {
	Database: new (bytes?: Uint8Array) => Database;
}

/**
 * How the WebAssembly gets in. A Worker imports the module at build time and
 * instantiates it here; a test reads the bytes off disk. Emscripten wants one of
 * these two and nothing else, so this is the whole seam.
 */
export interface WasmSource {
	/** A compiled module, which is what a Worker's `import x from "*.wasm"` gives. */
	module?: WebAssembly.Module;
	/** Raw bytes, which is what `fs.readFileSync` gives. */
	binary?: Uint8Array;
}

type SqlJsFactory = (config: Record<string, unknown>) => Promise<Sqlite>;

/**
 * loadSqlite instantiates the runtime ONCE per isolate.
 *
 * A Worker isolate serves many requests, and instantiating a 658 KB module per
 * request would be the most expensive thing this service does. The promise is
 * cached rather than the result, so two requests arriving during startup wait on
 * one instantiation instead of racing to start two.
 */
let loading: Promise<Sqlite> | undefined;

export function loadSqlite(factory: SqlJsFactory, wasm: WasmSource): Promise<Sqlite> {
	if (!loading) {
		loading = start(factory, wasm).catch((err: unknown) => {
			// A failed instantiation must not poison the isolate: the next request
			// gets to try again rather than inheriting a rejected promise forever.
			loading = undefined;
			throw err;
		});
	}
	return loading;
}

function start(factory: SqlJsFactory, wasm: WasmSource): Promise<Sqlite> {
	if (wasm.binary) return factory({ wasmBinary: wasm.binary });
	const module = wasm.module;
	if (!module) throw new Error("loadSqlite needs either a compiled module or the wasm bytes");
	return factory({
		// Emscripten's hook: build the instance ourselves, hand it back through
		// the callback, and return an empty exports object to say we did.
		instantiateWasm(
			imports: WebAssembly.Imports,
			ready: (instance: WebAssembly.Instance) => void,
		): Record<string, unknown> {
			ready(new WebAssembly.Instance(module, imports));
			return {};
		},
	});
}

/** Only for tests, which need each case to start from a cold isolate. */
export function forgetSqlite(): void {
	loading = undefined;
}

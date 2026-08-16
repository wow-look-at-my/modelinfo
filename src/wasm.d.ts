/**
 * Wrangler compiles an imported .wasm into the bundle and hands the Worker a
 * compiled module. TypeScript has no idea, so this says so.
 */
declare module "*.wasm" {
	const module: WebAssembly.Module;
	export default module;
}

declare module "sql.js" {
	const initSqlJs: (config?: Record<string, unknown>) => Promise<unknown>;
	export default initSqlJs;
}

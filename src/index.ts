import initSqlJs from "sql.js";
// Wrangler compiles this at build time, so the 658 KB module is instantiated
// rather than fetched, and the isolate never makes a subrequest to start.
import wasm from "sql.js/dist/sql-wasm.wasm";
import { handle } from "./service.ts";
import { loadSqlite } from "./sqlite.ts";
import { TTL_SECONDS } from "./ingest.ts";

export interface Env {
	/** Overrides the one-hour TTL. Unset is the default; unparseable is an error. */
	MODELINFO_TTL_SECONDS?: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			const sqlite = await loadSqlite(
				initSqlJs as unknown as (c: Record<string, unknown>) => Promise<never>,
				{ module: wasm },
			);
			return await handle(request, {
				sqlite,
				waitUntil: (p) => ctx.waitUntil(p),
				ttlSeconds: ttlOf(env),
			});
		} catch (err) {
			// A failure here is reported as one. There is no shape of this service
			// that answers 200 with nothing in it.
			return new Response(
				JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
				{
					status: 502,
					headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
				},
			);
		}
	},

	/**
	 * The hourly rebuild. It warms the cache in whatever colo the schedule runs
	 * in; every other colo warms itself on its first request. A failure here is
	 * thrown rather than logged, so a broken ingest shows up as a failed cron run
	 * instead of an hour of quiet.
	 */
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const sqlite = await loadSqlite(
			initSqlJs as unknown as (c: Record<string, unknown>) => Promise<never>,
			{ module: wasm },
		);
		const res = await handle(new Request("https://modelinfo.invalid/health"), {
			sqlite,
			waitUntil: (p) => ctx.waitUntil(p),
			ttlSeconds: ttlOf(env),
		});
		if (!res.ok) throw new Error(`the scheduled rebuild answered ${res.status}: ${await res.text()}`);
	},
};

/**
 * ttlOf reads the one knob. An unparseable value FAILS rather than falling back
 * to the default: a typo that silently reverts to an hour is a setting the
 * operator believes they changed.
 */
function ttlOf(env: Env): number {
	const raw = env.MODELINFO_TTL_SECONDS?.trim();
	if (!raw) return TTL_SECONDS;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(
			`MODELINFO_TTL_SECONDS is ${JSON.stringify(raw)}, which is not a positive number of seconds`,
		);
	}
	return Math.floor(n);
}

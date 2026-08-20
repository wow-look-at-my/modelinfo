import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { forgetInFlight, memoryStore, type SWRStore } from "../src/cache.ts";
import { SOURCES } from "../src/sources.ts";
import { forgetSqlite, loadSqlite, type Sqlite } from "../src/sqlite.ts";
import type { Service } from "../src/service.ts";
import type { SnapshotBucket } from "../src/snapshot.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, "fixtures");

/**
 * Tests load the WebAssembly from disk; the Worker imports it as a module. That
 * is the whole difference between the two, and it is why loadSqlite takes the
 * source rather than reaching for one.
 */
export async function sqlite(): Promise<Sqlite> {
	forgetSqlite();
	return loadSqlite(initSqlJs as never, {
		binary: fs.readFileSync(
			path.join(here, "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
		),
	});
}

/** The fixture file for a source: `.html` when one exists (crof's page is HTML),
 * `.json` otherwise. The fetcher and the split/ingest tests both load a source's
 * published records through this, so crof is exercised against real page bytes
 * rather than pre-cleaned JSON. */
export function fixtureFile(source: { name: string }): string {
	const html = path.join(FIXTURES, `${source.name}.html`);
	return fs.existsSync(html) ? html : path.join(FIXTURES, `${source.name}.json`);
}

/** Answers each source's URL from its fixture. */
export function fixtureFetcher(overrides: Record<string, () => Response> = {}): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		const override = overrides[url];
		if (override) return override();
		const source = SOURCES.find((s) => s.url === url);
		if (!source) throw new Error(`no fixture for ${url}`);
		const file = fixtureFile(source);
		return new Response(fs.readFileSync(file, "utf8"), {
			status: 200,
			headers: { "content-type": file.endsWith(".html") ? "text/html" : "application/json" },
		});
	}) as typeof fetch;
}

export interface Harness extends Service {
	fetcher: typeof fetch;
	store: SWRStore;
	/** Upstream calls, all of them or one URL's. Counting is the harness's job,
	 * so a test can swap in any fetcher and still measure it. */
	count(url?: string): number;
	/** Promises handed to waitUntil, so a test can await the work behind a response. */
	background: Promise<unknown>[];
	setNow(at: Date): void;
}

export async function harness(overrides: Partial<Service> = {}): Promise<Harness> {
	// The in-flight map is per-isolate in production, which means per-process
	// here: without this, one case's unsettled refresh is joined by the next
	// case, whose store and fetcher are different objects entirely.
	forgetInFlight();
	const background: Promise<unknown>[] = [];
	let at = new Date("2026-08-16T00:00:00.000Z");
	const calls = new Map<string, number>();
	const under = overrides.fetcher ?? fixtureFetcher();
	return {
		sqlite: await sqlite(),
		store: memoryStore(),
		waitUntil: (p) => {
			background.push(p);
		},
		now: () => at,
		...overrides,
		fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.set(url, (calls.get(url) ?? 0) + 1);
			return under(input, init);
		}) as typeof fetch,
		count: (url?: string) =>
			url ? (calls.get(url) ?? 0) : [...calls.values()].reduce((a, b) => a + b, 0),
		background,
		setNow: (next) => {
			at = next;
		},
	};
}

/** Runs everything queued behind responses so far, then clears the queue. */
export async function settle(h: Harness): Promise<void> {
	while (h.background.length) {
		const pending = h.background.splice(0, h.background.length);
		await Promise.all(pending);
	}
}

/** An in-memory stand-in for the R2 bucket, with its writes counted. */
export interface MemoryBucket extends SnapshotBucket {
	/** How many times a snapshot was stored. */
	writes: number;
	/** How many times one was asked for. */
	reads: number;
}

export function memoryBucket(): MemoryBucket {
	const held = new Map<string, { bytes: ArrayBuffer; meta: Record<string, string> }>();
	const bucket: MemoryBucket = {
		writes: 0,
		reads: 0,
		async get(key) {
			bucket.reads++;
			const entry = held.get(key);
			if (!entry) return null;
			return {
				arrayBuffer: async () => entry.bytes,
				customMetadata: entry.meta,
			};
		},
		async put(key, value, options) {
			bucket.writes++;
			held.set(key, { bytes: value, meta: options?.customMetadata ?? {} });
		},
	};
	return bucket;
}

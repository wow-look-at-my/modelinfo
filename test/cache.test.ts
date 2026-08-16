import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryStore, STAMP, swrFetch } from "../src/cache.ts";

/** A fetcher that counts calls and answers whatever body it is told to. */
function counting(bodies: string[]): { fetcher: typeof fetch; calls: () => number } {
	let n = 0;
	const fetcher = (async () => {
		const body = bodies[Math.min(n, bodies.length - 1)];
		n++;
		return new Response(body, { status: 200 });
	}) as unknown as typeof fetch;
	return { fetcher, calls: () => n };
}

/** Collects background work so a test can await it deliberately. */
function background() {
	const pending: Promise<unknown>[] = [];
	return {
		waitUntil: (p: Promise<unknown>) => void pending.push(p),
		settle: () => Promise.all(pending),
		count: () => pending.length,
	};
}

test("a cold cache fetches, and the bytes are what the upstream sent", async () => {
	const store = memoryStore();
	const { fetcher, calls } = counting(['{"a":1}']);
	const bg = background();

	const got = await swrFetch("https://example.invalid/x", {
		ttlSeconds: 60,
		waitUntil: bg.waitUntil,
		fetcher,
		store,
	});
	assert.equal(got.body, '{"a":1}');
	assert.equal(got.cold, true);
	assert.equal(got.stale, false);
	assert.equal(calls(), 1);
});

test("inside the TTL nothing is refetched", async () => {
	const store = memoryStore();
	const { fetcher, calls } = counting(['{"a":1}']);
	const bg = background();
	const opts = { ttlSeconds: 60, waitUntil: bg.waitUntil, fetcher, store };

	await swrFetch("https://example.invalid/x", opts);
	const second = await swrFetch("https://example.invalid/x", opts);

	assert.equal(second.cold, false);
	assert.equal(second.stale, false);
	assert.equal(calls(), 1, "the second read was served from cache");
	assert.equal(bg.count(), 0, "and nothing was queued behind it");
});

test("past the TTL the stale bytes are served and the refresh runs behind", async () => {
	const store = memoryStore();
	const { fetcher, calls } = counting(['{"v":"old"}', '{"v":"new"}']);
	let clock = new Date("2026-01-01T00:00:00Z");
	const bg = background();
	const opts = {
		ttlSeconds: 60,
		waitUntil: bg.waitUntil,
		fetcher,
		store,
		now: () => clock,
	};

	await swrFetch("https://example.invalid/x", opts);
	clock = new Date("2026-01-01T00:05:00Z");

	const stale = await swrFetch("https://example.invalid/x", opts);
	// The whole point: the caller was answered with the bytes already held,
	// never with whatever the refresh is about to return.
	assert.equal(stale.body, '{"v":"old"}');
	assert.equal(stale.stale, true);
	assert.equal(stale.ageSeconds, 300);
	assert.equal(bg.count(), 1, "and a refresh was queued behind the response");

	await bg.settle();
	assert.equal(calls(), 2);

	const fresh = await swrFetch("https://example.invalid/x", opts);
	assert.equal(fresh.body, '{"v":"new"}');
	assert.equal(fresh.stale, false);
});

test("a refresh that fails keeps the stale bytes rather than emptying the cache", async () => {
	const store = memoryStore();
	let clock = new Date("2026-01-01T00:00:00Z");
	let attempt = 0;
	const fetcher = (async () => {
		attempt++;
		if (attempt === 1) return new Response('{"v":"old"}', { status: 200 });
		return new Response("upstream is down", { status: 503 });
	}) as unknown as typeof fetch;
	const bg = background();
	const opts = { ttlSeconds: 60, waitUntil: bg.waitUntil, fetcher, store, now: () => clock };

	await swrFetch("https://example.invalid/x", opts);
	clock = new Date("2026-01-01T01:00:00Z");
	assert.equal((await swrFetch("https://example.invalid/x", opts)).body, '{"v":"old"}');
	await bg.settle();

	// Still the old bytes, still marked stale. Degraded is not broken, and the
	// age says exactly how degraded.
	const after = await swrFetch("https://example.invalid/x", opts);
	assert.equal(after.body, '{"v":"old"}');
	assert.equal(after.stale, true);
	assert.equal(after.ageSeconds, 3600);
});

test("a cold fetch that fails is an error, never an empty answer", async () => {
	const store = memoryStore();
	const fetcher = (async () =>
		new Response("nope", { status: 500 })) as unknown as typeof fetch;
	const bg = background();

	await assert.rejects(
		() => swrFetch("https://example.invalid/x", { ttlSeconds: 60, waitUntil: bg.waitUntil, fetcher, store }),
		/answered 500/,
	);
});

test("an empty 200 is a failure, not a document", async () => {
	const store = memoryStore();
	const fetcher = (async () => new Response("   ", { status: 200 })) as unknown as typeof fetch;
	const bg = background();

	await assert.rejects(
		() => swrFetch("https://example.invalid/x", { ttlSeconds: 60, waitUntil: bg.waitUntil, fetcher, store }),
		/empty body/,
	);
});

test("the entry is stored long past the TTL, so the stale copy is still there", async () => {
	const store = memoryStore();
	const { fetcher } = counting(['{"a":1}']);
	const bg = background();
	await swrFetch("https://example.invalid/x", {
		ttlSeconds: 60,
		waitUntil: bg.waitUntil,
		fetcher,
		store,
	});

	const held = await store.match("https://example.invalid/x");
	assert.ok(held);
	// Freshness is this file's arithmetic. If Cache-Control decided it, the
	// Cache API would evict the entry at the TTL and there would be no stale
	// copy left to serve.
	assert.match(held.headers.get("cache-control") ?? "", /max-age=2592000/);
	assert.ok(held.headers.get(STAMP));
});

test("concurrent readers of a cold URL make ONE upstream request", async () => {
	const store = memoryStore();
	const { fetcher, calls } = counting(['{"a":1}']);
	const bg = background();
	const opts = { ttlSeconds: 60, waitUntil: bg.waitUntil, fetcher, store };

	// Without in-flight collapsing, the moment an hour elapses the upstream
	// takes a burst instead of a request.
	const all = await Promise.all(
		[1, 2, 3, 4, 5].map(() => swrFetch("https://example.invalid/herd", opts)),
	);
	assert.equal(calls(), 1);
	for (const got of all) assert.equal(got.body, '{"a":1}');
});

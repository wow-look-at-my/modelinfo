import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../src/service.ts";
import { BUILT_AT, SNAPSHOT_KEY } from "../src/snapshot.ts";
import { harness, memoryBucket, settle } from "./helpers.ts";

const AT = "https://modelinfo.pazer.ai";
const START = new Date("2026-08-16T00:00:00.000Z");

function get(h: Parameters<typeof settle>[0], path: string): Promise<Response> {
	return handle(new Request(AT + path), h);
}

test("a build stores the database where every colo can read it", async () => {
	const snapshot = memoryBucket();
	const h = await harness({ snapshot });

	await get(h, "/v1/models");
	await settle(h);

	assert.equal(snapshot.writes, 1, "the build wrote one snapshot");
	const stored = await snapshot.get(SNAPSHOT_KEY);
	assert.ok(stored, "under the versioned key");
	assert.equal(stored.customMetadata?.[BUILT_AT], START.toISOString(), "stamped when it was built");
});

test("a colo with a cold cache reads the snapshot instead of building one", async () => {
	const first = memoryBucket();
	const warm = await harness({ snapshot: first });
	await get(warm, "/v1/models");
	await settle(warm);

	// A different colo: its own cache, its own isolate, the same bucket.
	const cold = await harness({ snapshot: first });
	const before = cold.count();
	const res = await get(cold, "/v1/models");

	assert.equal(res.status, 200);
	assert.equal(cold.count(), before, "no upstream was fetched");
	assert.equal(first.writes, 1, "and nothing was rebuilt");
});

test("a snapshot past the TTL is served, and rebuilt behind the response", async () => {
	const snapshot = memoryBucket();
	const warm = await harness({ snapshot });
	await get(warm, "/v1/models");
	await settle(warm);

	// An upstream that never answers. A response that arrives anyway is a
	// response that waited on no upstream, which counting calls cannot show:
	// the rebuild behind the response starts its fetches straight away.
	const stuck = await harness({
		snapshot,
		fetcher: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
	});
	stuck.setNow(new Date(START.getTime() + 2 * 3600 * 1000));

	const res = await get(stuck, "/v1/models");
	assert.equal(res.status, 200, "served from the snapshot");

	// And with an upstream that does answer, the rebuild lands.
	const cold = await harness({ snapshot });
	cold.setNow(new Date(START.getTime() + 2 * 3600 * 1000));
	await get(cold, "/v1/models");
	await settle(cold);
	assert.equal(snapshot.writes, 2, "the rebuild replaced the snapshot");
});

test("a snapshot with no build time is refused rather than dated to now", async () => {
	const snapshot = memoryBucket();
	await snapshot.put(SNAPSHOT_KEY, new Uint8Array([1, 2, 3]).buffer as ArrayBuffer, {});

	const h = await harness({ snapshot });
	const res = await get(h, "/v1/models");

	assert.equal(res.status, 200, "the service built the database itself");
	assert.ok(h.count() > 0, "which means it read the upstreams");
});

test("without a bucket the service still answers, by building its own", async () => {
	const h = await harness();
	const res = await get(h, "/v1/models");
	assert.equal(res.status, 200);
	assert.ok(h.count() > 0);
});

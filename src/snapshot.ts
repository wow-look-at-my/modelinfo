/**
 * The last built database, held where every colo can read it.
 *
 * The Cache API is per-colo, so a colo that has never answered a request has
 * nothing to serve and builds the database itself: four upstream documents,
 * 22 MB of JSON, several seconds. That is the only slow answer this service
 * gives, and this file removes it. A colo that has no cached database reads
 * the snapshot instead of building one, and rebuilds behind the response.
 *
 * The snapshot carries the time its bytes were built, not the time they were
 * read. A colo that loads an hour-old snapshot must refresh it on the next
 * request, and a stamp written at read time would hide that for a whole TTL.
 */

/** The R2 slice this uses, so a test can supply a Map. */
export interface SnapshotBucket {
	get(key: string): Promise<SnapshotObject | null>;
	put(key: string, value: ArrayBuffer, options?: SnapshotPutOptions): Promise<unknown>;
}

export interface SnapshotObject {
	arrayBuffer(): Promise<ArrayBuffer>;
	customMetadata?: Record<string, string>;
}

export interface SnapshotPutOptions {
	customMetadata?: Record<string, string>;
}

/** The object name. Versioned, so a schema change never reads the old shape. */
export const SNAPSHOT_KEY = "v1/models.sqlite";

/** The metadata key carrying when the bytes were built. */
export const BUILT_AT = "built-at";

export interface Snapshot {
	bytes: ArrayBuffer;
	builtAt: Date;
}

/**
 * read returns the stored snapshot, or undefined when there is none.
 *
 * A snapshot with no usable stamp is REFUSED rather than dated to now: bytes of
 * unknown age would be served as fresh for a whole TTL.
 */
export async function read(bucket: SnapshotBucket): Promise<Snapshot | undefined> {
	const object = await bucket.get(SNAPSHOT_KEY);
	if (!object) return undefined;
	const stamp = object.customMetadata?.[BUILT_AT];
	if (!stamp) return undefined;
	const builtAt = new Date(stamp);
	if (Number.isNaN(builtAt.getTime())) return undefined;
	return { bytes: await object.arrayBuffer(), builtAt };
}

/** write stores freshly built bytes with the time they were built. */
export async function write(bucket: SnapshotBucket, bytes: ArrayBuffer, builtAt: Date): Promise<void> {
	await bucket.put(SNAPSHOT_KEY, bytes, {
		customMetadata: { [BUILT_AT]: builtAt.toISOString() },
	});
}

# The R2 snapshot, and the several-second answer it removes

## The problem

`caches.default` is per-colo. The hourly cron warms one colo. Every other colo
warms itself on its first request, and warming means the ingest: four upstream
documents, 22 MB of JSON, a merge of 17,316 records into a SQLite database.
Measured against the live deployment that is 5.2 to 13 seconds, and the person
who pays it is whoever asks first in a colo the cron never touched.

A warm colo answers in under a second. A cold one does not, and no amount of
caching in front of the Worker fixes it, because there is nothing to cache yet.

## What it does

The Worker keeps the last built database in one R2 bucket, `SNAPSHOT`, under
`v1/models.sqlite`. R2 is account-wide, so a colo with a cold cache reads the
last build instead of making one. Only a request that finds no snapshot at all
pays for a build, which happens once in the life of the bucket.

Both writers are the same path: any build, whether it ran for a cold cache or
behind a response, stores its bytes. The write runs on `waitUntil`, so a colo
that cannot write has still answered.

## Freshness

The snapshot's `built-at` metadata is the time the DATABASE was built. It is
carried into the cache as the entry's own stamp, so a colo that loads an
hour-old snapshot serves it and rebuilds behind that first response. A stamp
written at read time would call those bytes fresh for another hour, which is
the silent staleness this design exists to avoid.

A snapshot with a missing or unparseable `built-at` is refused, and the colo
builds its own. Bytes of unknown age are worse than a slow answer.

## Operating it

The bucket must exist before a deploy:

```sh
wrangler r2 bucket create modelinfo-snapshot
wrangler deploy
```

The binding is REQUIRED. A deploy without it throws on every request rather
than falling back to the per-colo build, because that fallback answers in
seconds and nothing in the response would say so.

## Why not the alternatives

- **Bundling a prebuilt database in the Worker.** The database is 20 MB, past
  the bundle limit, and it would be as old as the last deploy.
- **A wider cron.** A schedule fires in one colo. It cannot warm the others.
- **KV.** The 25 MB value limit leaves no room, and this is one object rewritten
  hourly — exactly what R2 stores.

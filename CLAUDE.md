# CLAUDE.md

Notes for Claude working in this repository.

## What this is

`modelinfo` — a Cloudflare Worker that merges six model catalogues into one and
serves it at `modelinfo.pazer.ai`, so that no model shows a blank where its price
should be. `/v1/models` is OpenAI's shape, `/db` is the ingest as a SQLite file.

It has ONE artifact: a SQLite database, rebuilt hourly. Everything else is a
projection of it.

## Build & test

```sh
npm install
npm test          # node --test over test/*.test.ts
npm run typecheck # src against workers-types, tests against node types
npm run dev       # wrangler dev --local, hits the live upstreams
```

Tests run against real slices of all six sources (`test/fixtures/`), because
every merge rule is about how independent sources disagree — two spellings of one
model, a `base_model` nineteen priced variants share, a provider-prefixed twin
that must not merge, a source whose prices are per million tokens. A hand-written
stub agrees with itself and proves none of it.

## The layering

- **`split.ts` finds structure; it never interprets a value.** It hands back raw
  slices and everything it returns still goes through `JSON.parse`. Changing it
  means re-running its agreement check against `JSON.parse` on the real
  documents, not just the fixtures.
- **`ollama.ts` is the one source that is TRANSCRIBED, not sliced.** ollama.com
  publishes no JSON, so its records are written from the listing page's
  capability pills — the only source that knows which ollama models embed. It is
  outside `split.ts` because every line of it interprets a value.
  `docs/ollama.md`.
- **`ingest.ts` writes the database; `catalogue.ts` reads it.** Neither ever
  holds the catalogue. If you find yourself building an array of models, stop.
- **`service.ts` is the routes and takes its dependencies as arguments;
  `index.ts` is the only file that knows it is a Worker** — the WebAssembly
  import, `caches.default`, `env`, the cron. That is what lets every route be
  tested with no Worker runtime in sight.
- **`merge.ts` decides what two records mean together.** `joinKey` is the whole
  identity rule; read its comment before changing anything about matching.

## Hard rules

- **Memory is the binding constraint, and it is measured, not guessed.** 128 MB
  per isolate, and WebAssembly memory only ever grows. Before changing anything
  in the ingest path, read `docs/memory.md` — it has the numbers, the three
  designs that did not fit, and how to re-measure.
- **Nothing is ever silently degraded.** A source that fails is named in
  `degraded`, in `/health` (which answers 503), and in its own row. A filter
  states how many models it removed. An unknown query parameter is a 400, never
  an ignored word.
- **A build with no usable source THROWS.** An empty catalogue served as if it
  were an answer is the one outcome worse than an error.
- **A document that will not parse is an error, not an empty source.** An
  upstream serving an error page and an upstream with nothing to say are
  different facts.
- **A request never waits on work already done once.** Past the TTL the cached
  bytes are served as they are and the refresh runs behind the response. A colo
  with a cold cache reads the R2 snapshot rather than building its own, so only
  a request that finds no snapshot pays for a build. See `docs/snapshot.md`.
- **A snapshot carries the time it was BUILT, not the time it was read.** A colo
  that loads an hour-old snapshot must refresh on the next request, and a stamp
  written at read time would hide that for a whole TTL. A snapshot with no
  usable stamp is refused rather than dated to now.
- **A background rebuild waits for fresh sources.** Nobody is waiting on it, and
  a rebuild that accepted stale sources would carry an upstream change no further
  than the hour it was already behind.
- **The database stores facts, not derived state.** It records when a source was
  fetched and never how old it was — an age written at build time is the age the
  data was then, and this database is served stale for up to an hour.
- **`record.doc` is the source's own bytes.** Not re-serialized, not normalized,
  not reordered, minus at most one field held once in `blob`. Query
  `record_full`, which puts it back. crof publishes prices per MILLION tokens;
  those per-million values are stored verbatim in `doc` and divided by 1e6 only
  at fold time, so a rate in `pricing` is never the source's own number in the
  wrong unit.
- **A rate is a decimal string, and a negative is refused rather than clamped.**
  A wrong number in a money column is worse than a missing one.
- **A source states only what its document says.** `ollama-library` is the
  lowest-priority source on every `ollama/*` key, so the `chat` it once assumed
  for a family with no pill beat litellm's stated `completion`. It writes `mode`
  only where a pill states one; a reading goes in `ingest.ts`'s `modeFor`, where
  nothing inherits it. An ollama TAG takes its FAMILY's stated mode — that is
  what corrects the 37 embedding models bifrost publishes as `chat`.
  `docs/ollama.md`.

## Gotchas that cost real time

- **sql.js does not start in a Worker unsupervised.** Its emscripten glue reads
  `self.location.href` when it sees `WorkerGlobalScope`, which workerd defines
  without a `location`. `src/sqlite.ts` shadows the global for the length of the
  factory call and explains why the two obvious fixes silently do nothing.
- **The Cache API wants a `Request`, not a string key.** A bare string reaches
  workerd as something with no `.href`.
- **`caches.default` is per-colo**, so the hourly cron warms one colo and every
  other warms itself on its first request. It warms itself from the R2 snapshot,
  which is what keeps that first request under a second.
- **D1 cannot serve its own file.** `D1Database.dump()` works only on databases
  created during D1's alpha period, which is why this uses sql.js and not D1.

## Git workflow

- One branch and one PR per session; branch names follow `claude/<name>`.
- Commit and push frequently — the working VM is ephemeral.
- PRs are squash-merged: add follow-up commits, never rebase or force-push.

## Where the depth lives

- `docs/memory.md` — the 128 MB problem, what failed, what the numbers are.
- `docs/snapshot.md` — the R2 snapshot: the cold colo, freshness, the bucket.
- `docs/ollama.md` — the transcribed source: the pills, family-to-tag mode, what
  it corrected.

This file is an index. If a change needs more than a few lines of explanation,
write `docs/<topic>.md` and leave a pointer.

# Fitting a 12,000-model catalogue in a 128 MB isolate

Every design decision in this repo that looks strange is here. A Cloudflare
Worker isolate is capped at 128 MB, the four upstream documents are 22 MB of
JSON, and the merged catalogue is 12,078 models. The obvious implementation does
not fit, and neither did the first three less obvious ones.

Numbers below are measured against the live documents, not estimated.

## What the sources are

| Source | Text | Records |
|---|---|---|
| openrouter | 0.6 MB | 413 |
| ollama-library | 0.8 MB | 235 |
| bifrost-datasheet | 1.6 MB | 3,930 |
| bifrost-parameters | 18.1 MB | 9,934 |
| litellm | 1.7 MB | 3,040 |

bifrost-parameters is the whole problem. 14.6 MB of its 18.1 MB is one field,
`model_parameters` — a UI form schema (labels, help text, ranges) published per
model, of which there are 520 distinct values across 10,021 records.

## What did not work

**Merging into JS objects.** The first implementation held the merged catalogue
as `Map<string, Model>`. Live set 42 MB, but the peak needed more than 160 MB of
old space and died outright at 128: `JSON.parse` of an 18 MB document allocates
28 MB of objects on top of the 18 MB of text, and four documents were parsed and
held at once.

**Folding one source at a time.** Real improvement — the cold build survived a
112 MB cap where it had needed 160 — and still not enough, because the largest
document's text and object graph coexist with the accumulator no matter what
order you read them in.

**Interning equal values during `JSON.parse`.** A reviver that folded equal
objects onto their first sibling made it *worse*: the reviver runs bottom-up and
serializing each container to compare it means serializing the whole 18 MB
document at the root. Weighing a container from its already-interned children
fixed the blow-up but not the underlying cost — the parse still allocates every
duplicate before anything can collapse them.

## What worked

**Never build the object graph.** `src/split.ts` walks a document once and hands
back raw slices, so each ~2 KB record is parsed on its own and the document is
never more than text. It is not a JSON parser: it finds where one value ends,
which needs only quoting, escaping and nesting depth. It is verified against
`JSON.parse` on all 17,316 real records, plus adversarial cases, and malformed
input throws rather than yielding a truncated record.

**Store the catalogue in SQLite, not in JS.** SQLite pages are a compact
representation of this data and JS objects are not. Rows go in one source at a
time and come out one query at a time: a filter is a WHERE clause, a listing is
one ordered cursor folded model by model, and a single model is an indexed
lookup. The JS heap peaks at 20 MB.

**Hold the repeated field once.** Each record's largest object-valued field goes
in `blob` and is referenced; the `record_full` view puts it back with one
`json_set`. 10,021 references collapse to 520 values — 1.07 MB held once rather
than 14.6 MB held over and over.

**No rollback journal.** The database is built from nothing in memory and thrown
away if the build fails, so a journal only bought the ability to undo a
statement, in the same memory the isolate is capped at. A source that fails
deletes its own rows.

## Where it landed

|  | JS heap | WASM | Total | Database |
|---|---|---|---|---|
| objects, four sources at once | >128 (OOM) | — | >160 | — |
| SQLite, verbatim records | 21.6 MB | 98.5 MB | 122.2 MB | 32.8 MB |
| SQLite, repeated field held once | 20.0 MB | 62.0 MB | **82.0 MB** | **18.9 MB** |

`ollama-library` was added after the table below was measured, and the table has
NOT been re-taken against it — what exists is a paired A/B: the same build, over
the same live documents, with and without the source. It cost about 6 MB of
`heapUsed` and left `arrayBuffers` flat, on 0.8 MB of text and 235 small rows
read as slices like everything else. That is a delta measured one way, not a row
of the table: re-take the table properly before relying on an absolute.
See `docs/ollama.md`.

46 MB of headroom rather than 6. That margin is the point: WebAssembly memory
only ever grows, so an isolate that runs one ingest keeps its high-water mark
for its whole life, and the next upstream that doubles in size must not be the
thing that takes the service down.

CPU: 4.2 s to ingest, 0.8 s to stream the full 19.2 MB answer, both well inside
the configured `cpu_ms = 30000`. Both happen at most once per hour per colo,
because everything in front of them is cached.

## How to re-measure

The measurement is a build against the four documents with a disk-backed store —
disk, because that is what the Cache API is: bytes held outside the isolate.
A Map-backed store charges the heap for 22 MB production never puts there.
Sample `heapUsed` and `arrayBuffers` separately: `rss` includes Node itself and
mapped-but-unused GC pages, and reads about 90 MB high.

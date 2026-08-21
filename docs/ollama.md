# Reading ollama's library, and why a tag asks its family

## What was wrong

`modelinfo` published `mode: "chat"` for every ollama embedding model.

Measured against the live documents, before this source existed:

| Source | ollama keys | `chat` | `completion` | `embedding` |
|---|---|---|---|---|
| bifrost-parameters | 6,321 | 6,308 | 8 | 5 |
| bifrost-datasheet | 29 | 21 | 8 | 0 |
| litellm | 29 | 21 | 8 | 0 |

Forty-two of bifrost-parameters' keys belong to the twelve families ollama
lists as embedding models. Five of them -- `granite-embedding:*` -- say
`embedding`. The other thirty-seven say `chat`:

```json
"nomic-embed-text:v1.5": {
    "provider": "ollama",
    "mode": "chat",
    "supports_function_calling": true,
    ...
}
```

That model returns a vector. It has no tools, and there is nothing to converse
with. `chat` there is not a mistake about one model: it is a constant applied to
a whole library, right for most of it and wrong for every embedding model in it.
bifrost does label `embedding` correctly elsewhere -- 14 `vertex_ai` keys, 14
`bedrock`, 15 `voyage` -- so the fault is specific to how it reads ollama.

The consequence for a caller: `?mode=embedding&provider=ollama` answered with
five models, all of them one family, and `nomic-embed-text` -- 83M pulls, six
times the next embedding model ollama publishes -- was offered as something to
send a conversation to.

## The source that knows

`https://ollama.com/library` is ollama's own catalogue. One request returns all
235 families, and each carries its capabilities inline as coloured pills:

```html
<a href="/library/nomic-embed-text" class="group w-full space-y-5">
  ...
  <p class="max-w-lg break-words text-neutral-800 text-md">A high-performing open embedding model...</p>
  <div class="flex flex-col space-y-2">
    <div class="flex flex-wrap space-x-2">
      <span class="... text-indigo-600 ...">embedding</span>
```

Twelve families carry the `embedding` pill: `all-minilm`, `bge-large`, `bge-m3`,
`embeddinggemma`, `granite-embedding`, `mxbai-embed-large`, `nomic-embed-text`,
`nomic-embed-text-v2-moe`, `paraphrase-multilingual`, `qwen3-embedding`,
`snowflake-arctic-embed` and `snowflake-arctic-embed2`. That is exactly the set
ollama's own `?c=embedding` filter returns, which is what makes the pill worth
reading rather than a decoration to interpret.

There is no JSON anywhere on it. `/api/library`, `/library.json`, `/api/models`
and `/api/search` all answer 404, and `?format=json` is ignored. The page is
server-rendered htmx markup, so `htmlAnchor` -- which finds a JSON array
embedded in HTML, as crof's page has -- cannot be pointed at anything.

## So the records are transcribed

`src/ollama.ts` reads the page and WRITES a record per family:

```json
{"provider":"ollama","mode":"embedding","capabilities":["embedding"],"sizes":[],
 "description":"A high-performing open embedding model with a large token context window."}
```

This is the one source whose `record.doc` is not an upstream's own bytes,
because there are none. That is why it does not live in `split.ts`: that file
finds structure and never interprets a value, and every line of the transcriber
interprets one. `ingest.ts`'s `recordsOf` names the exception at the seam.

### A pill is classified by its colour class, not by its text

The page draws capabilities indigo (`text-indigo-600`), parameter sizes blue
(`text-blue-600`), and the families it also hosts in its cloud cyan
(`text-cyan-500`). Reading a pill's KIND off its TEXT looks equivalent and is
not: `8b` and `1.7b` are sizes, but so are `8x7b`, `8x22b`, `16x17b`,
`128x17b`, `e2b` and `e4b`, and a regex for "looks like a parameter count" puts
all six in with `tools` and `thinking`. The first draft of this did exactly
that. The colour is the page's own distinction, and using it is reading the page
rather than re-deriving it worse.

`cloud` is read and not carried: it says ollama also hosts the family, which is
a fact about ollama's hosting rather than about the weights.

### It states `mode` only where a pill states one

`ollama-library` is priority 1, below both bifrost sources and litellm, so
anything it writes wins outright on an `ollama/*` key. That is correct for what
the page knows and dangerous for what it does not: writing `mode: "chat"` for
every family with no `embedding` pill beat litellm's stated `completion` on six
of the eight ollama base models, and the first live build did exactly that --
`completion` fell from 8 to 2. One blanket label traded for another.

So the record carries `mode` only for a family the page marks `embedding`. A
family the page lists that no source gives a mode to falls to the source's
`defaultMode` (`chat`), which fills a gap and never overwrites a stated mode --
see "What a source can answer for" below.

A pill naming a modality that is not a conversation -- a rerank, say -- has to
be added to `MODES` in `ollama.ts`. Nothing detects one on its own. That is the
price of only ever asserting what the page prints.

## What a source can answer for

`Source.defaultMode` is what a whole DOCUMENT is, for a record no source gave a
mode. It is not an inference about any model in it, and nothing anywhere reads a
model's name to decide a modality: `kimi-k3` is a chat model because crof's
pricing page is a chat-model price list, not because of what it is called.

Two sources declare one. crof's `allModels` array carries no `mode` field on any
of its 21 entries, so before this every crof model was served as `unknown` and
hidden by the default filter. ollama's library is a catalogue of models you run
and talk to, minus the ones its own pills mark otherwise. The rest declare
nothing, because they publish image, audio, rerank and embedding models beside
chat ones and genuinely cannot answer for a record that says nothing.

It is the LAST thing consulted. A mode any source stated wins, which is what
keeps `ollama/codellama` on litellm's `completion`; and a record no source can
answer for stays `unknown`, which the default filter excludes and the response
counts. That is still 21 models on the live documents: thirteen one-field
fragments bifrost-parameters publishes with no provider and no mode, and eight
fireworks pricing tiers.

## A tag asks its family

The 235 family records fix nothing on their own, because nobody runs
`ollama/nomic-embed-text`. They run `ollama/nomic-embed-text:v1.5`, and a tag
has no page of its own: it exists in the catalogue only as a bifrost key that
says `chat`. Before this change the catalogue held no bare `ollama/<family>`
record at all -- all 6,321 ollama keys were tagged.

A tag is a quantization or a parameter count of one family's weights, and
nothing about a tag changes what the model does. So `modeFor` lets a family
answer for every tag under it:

```
ollama/nomic-embed-text          <- states embedding, remembered
ollama/nomic-embed-text:v1.5     <- bifrost says chat; the family answers
```

The pass is `ORDER BY join_key, priority` and `ollama/x` is a proper prefix of
`ollama/x:tag`, so a family is always folded before any tag under it. Only a
mode the page STATED is remembered -- `statedMode` re-reads the family's own
capability pills rather than the mode the fold arrived at -- so a `chat` this
service assumed is never inherited by anything.

The map holds one entry per ollama family the page marks. At twelve entries it
is not the catalogue-shaped thing `ingest.ts` is otherwise forbidden to build;
even at all 235 it is about 10 KB.

## A moved page fails, loudly

If ollama restyles the listing, every family still parses and every capability
disappears. Nothing about that is visible in the output: the build succeeds, the
source reports 235 healthy records, and every embedding model quietly reads
`chat` again -- the exact bug this source exists to fix, restored with a green
build on top of it.

So a page with families and not one `text-indigo-600` pill THROWS, and so does a
page with no `/library/` links at all. A source that throws contributes nothing,
is named in `modelinfo.degraded`, and makes `/health` answer 503. `ingest.ts`
deletes its half-written rows, and the other five sources still build a
catalogue.

## What it changed

Built against the live documents on 2026-08-21, with and without the source:

| | models | ollama `chat` | ollama `completion` | ollama `embedding` |
|---|---|---|---|---|
| before | 12,204 | 6,308 | 8 | 5 |
| after | 12,429 | 6,484 | 8 | **54** |

Separately, `defaultMode` took the catalogue's `unknown` models from 43 to 21:
crof's 19 are chat models again rather than models the default view hides.

The 54 are the 12 family records plus the 42 tags under them. Forty-nine of them
were not findable as embedding models before; 37 of those are tags that were
published as chat models. `completion` is unchanged, which is the check that the
correction did not become a blanket label of its own.

Cost: one more request, 0.8 MB of text, 235 rows. Both columns are the same
build over the same documents, so the memory figure is a paired delta rather
than a row of `docs/memory.md`'s table: about 6 MB more `heapUsed`, with
`arrayBuffers` flat. The page is read once, as slices, and the rows it writes
are small.

## Re-measuring, or re-slicing the fixture

`test/fixtures/ollama-library.html` is a real slice of the page: the markup
around seven families, kept verbatim. Regenerate it by fetching
`https://ollama.com/library` and keeping the `<a href="/library/NAME">` block of
each family in `test/fixtures/README.md`'s list, plus enough of the page before
the first one to keep the surrounding markup real.

# modelinfo

One model catalogue, merged from five sources, served at
**https://modelinfo.pazer.ai** in the OpenAI `/v1/models` shape.

It exists so that no model shows a blank where its price should be.

```sh
curl https://modelinfo.pazer.ai/v1/models/claude-opus-4-5 | jq .pricing
curl https://modelinfo.pazer.ai/v1/models?provider=anthropic
curl -o modelinfo.sqlite https://modelinfo.pazer.ai/db
```

## Routes

| Route | Answers |
|---|---|
| `/v1/models` | OpenAI's list document, plus a `modelinfo` block naming the sources |
| `/v1/models/{id}` | One model, by any name it answers to |
| `/db` | The whole thing as a SQLite file |
| `/health` | Source ages and errors, without the catalogue |

`/v1/models` takes `?mode=`, `?provider=` and `?q=`. By default it hides image,
audio, video, embedding and rerank models; `?mode=all` includes them. An
unrecognized parameter is a 400 rather than a silent no-op. Every answer states
how many models the filter removed.

## Sources

Merged in this order — the first to publish a field owns it, and later sources
fill gaps:

1. [OpenRouter](https://openrouter.ai/api/v1/models)
2. [Bifrost datasheet](https://getbifrost.ai/datasheet)
3. [Bifrost model parameters](https://getbifrost.ai/datasheet/model-parameters)
4. [LiteLLM](https://raw.githubusercontent.com/BerriAI/litellm/refs/heads/main/model_prices_and_context_window.json)
5. [crof.ai](https://crof.ai/pricing) — a routing provider with no public API;
   its pricing page inlines an `allModels` array in HTML, which this source
   extracts. crof is the only source publishing per-model `speed` (tok/s),
   `cache_rate`, and `quantization`, and the only one whose prices are per
   **million** tokens — they are divided by 1e6 at fold time so they enter the
   unified `pricing` in USD-per-token like every other source.

`pricing` is the exception: it is assembled per rate, so a model OpenRouter
prices for prompt and completion still picks up a cache-write rate only LiteLLM
published. Rates are decimal strings in USD per token.

Everything each source published survives under its own name beside the merged
fields. Nothing is dropped.

## Caching

Sources and answers are cached for an hour and served **stale while they
refresh**, so a request never waits on an upstream that has already answered
once. A source that fails is named in `modelinfo.degraded` and in `/health`,
which returns 503; the models that did load are still served, and the answer
says it is incomplete.

## The database

`/db` is the ingest itself: every source's records verbatim, keyed by model,
plus the identity tables a query needs. Query `record_full`, not `record`.

```sh
sqlite3 modelinfo.sqlite "SELECT id, provider, mode FROM model WHERE provider = 'anthropic'"
sqlite3 modelinfo.sqlite "SELECT source, json_extract(doc, '\$.input_cost_per_token')
                          FROM record_full WHERE join_key = 'anthropic/claude-opus-4-5'"
```

## Development

```sh
npm install
npm test          # 68 tests, against real slices of all five sources
npm run typecheck
npm run dev       # wrangler dev, hits the live upstreams
```

Notes for anyone working on this are in [CLAUDE.md](./CLAUDE.md), and the
design that is not obvious from the code is in [docs/](./docs).

# Fixtures

Real bodies from the six live sources, sliced to ~20 models each.

They are REAL because the merge rules are entirely about how independent
sources disagree -- two spellings of one model, a `base_model` nineteen priced
variants share, a provider-prefixed twin that must not merge, a source whose
prices are per million tokens. A hand-written stub agrees with itself, and would
pass every rule this repo has while proving none of them.

The slice keeps, deliberately:

- `gpt-5.2` and `openai/gpt-5.2` -- the same model, named differently by
  litellm and OpenRouter. The join has to see one model.
- `azure/gpt-5.2`, `azure/gpt-4` -- same weights, different bill. Must not
  merge with OpenAI's.
- the `gpt-image-1.5` family -- one `base_model`, prices from $0.009 to $0.200.
- one live record of each mode the default filter hides.
- litellm's `sample_spec`, which is its schema documentation checked into the
  model map. It is not a model.

`crof.html` is different in shape, not in spirit: crof.ai has no public API, so
the fixture is a real slice of the `https://crof.ai/pricing` HTML around the
inline `const allModels = [...]` array (not pre-cleaned JSON), so the
HTML-to-array extraction is tested against the page's actual bytes. It keeps:

- `deepseek-v4-pro-0813` -- `prompt: "0.35"` per million, which folds to
  `0.00000035` per token (the plan's example of the ÷1e6 scaling).
- `glm-5.2` -- whose `pricing` mixes rates with a `discount` and `*_original`
  fields, so the rate-field split is exercised.
- per-model `speed` (tok/s), `cache_rate`, and `quantization` -- the page-only
  facts crof contributes that no other source has.

`ollama-library.html` is a real slice of `https://ollama.com/library` -- ollama
publishes no JSON, so the page's own markup is what the transcriber reads (see
`docs/ollama.md`). Seven families, each kept for a case:

- `nomic-embed-text`, `granite-embedding` -- both embedding families. bifrost
  calls the first one's tags `chat` and gets the second's right, so the fix and
  the no-op are both covered.
- `qwen3` -- `tools` and `thinking`, plus eight parameter-size pills.
- `gemma3n` -- sizes `e2b`/`e4b`, which anything classifying a pill by the shape
  of its text reads as capabilities.
- `gemma4` -- four capabilities, and the cyan `cloud` pill that is not one.
- `codellama` -- the page states no mode for it and litellm states `completion`,
  which is what a source asserting a `chat` it assumed would overwrite.
- `openhermes` -- no pills at all.

`bifrost-parameters.json` keeps `nomic-embed-text:v1.5` (published `chat`, with
`supports_function_calling` beside it), `granite-embedding:30m` and
`qwen3:8b-q4_K_M`: the tags are where the mislabelling actually reaches a model
somebody runs, and no bare `ollama/<family>` key exists in bifrost at all.

Regenerate by fetching each source in `src/sources.ts` and keeping those keys
(for crof, the slice around the `allModels` array; for ollama, each family's
`<a href="/library/NAME">` block plus enough of the page before the first one to
keep the surrounding markup real).

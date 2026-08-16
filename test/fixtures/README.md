# Fixtures

Real bodies from the four live sources, sliced to ~20 models each.

They are REAL because the merge rules are entirely about how four independent
sources disagree -- two spellings of one model, a `base_model` nineteen priced
variants share, a provider-prefixed twin that must not merge. A hand-written
stub agrees with itself, and would pass every rule this repo has while proving
none of them.

The slice keeps, deliberately:

- `gpt-5.2` and `openai/gpt-5.2` -- the same model, named differently by
  litellm and OpenRouter. The join has to see one model.
- `azure/gpt-5.2`, `azure/gpt-4` -- same weights, different bill. Must not
  merge with OpenAI's.
- the `gpt-image-1.5` family -- one `base_model`, prices from $0.009 to $0.200.
- one live record of each mode the default filter hides.
- litellm's `sample_spec`, which is its schema documentation checked into the
  model map. It is not a model.

Regenerate by fetching each source in `src/sources.ts` and keeping those keys.

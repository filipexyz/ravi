# Runbook

## Update a session's runtime atomically

```bash
ravi sessions update <session> --provider claude --model sonnet --effort ultra --thinking off
```

- Any subset of axes works; `clear` removes that override.
- Success prints the effective runtime and the probe duration.
- Failure exits with `RUNTIME_PROBE_FAILED`, names the probe error, and the
  session keeps its previous configuration (already restored).

## When the write is refused immediately

The error names the invalid value and the valid ones, e.g.:

```
Unknown claude model: 'fable-9-9' is not in this installation's model catalog. Valid models: sonnet, haiku, opus.
```

- Model missing from the Claude/Grok list → the catalog
  (`src/runtime/model-catalog.ts`) is compiled in; new models arrive with the
  provider SDK bump PR that teaches the installation to run them.
- Codex model refused → the installation's models cache disagrees
  (`$CODEX_HOME/models_cache.json` or `~/.codex/models_cache.json`; override
  with `RAVI_CODEX_MODELS_CACHE`). Refresh it by running the Codex CLI once.

## When the probe fails on a valid-looking selection

The probe error is the provider's real failure. Frequent causes:

- `Not logged in` / credential errors → the pool has no credential for that
  provider/model pair (see `ravi providers`/credential docs).
- Timeout → provider binary hung or very slow; retry with
  `--probe-timeout 300`.

## Skipping the probe

```bash
ravi sessions update <session> --effort low --skip-probe
```

Applies without proof (no rollback protection). Use for offline hosts or bulk
administrative sweeps, and say so in the report.

## Testing notes

- Under `bun test` (NODE_ENV=test) the Codex cache default is disabled; pass
  `codexCachePath` to `validateRuntimeModelSelector` to exercise enforcement.
- `probeRuntimeTurn` accepts `createProvider` and `resolveCredential` seams.
- `applySessionRuntimeUpdate` accepts a `deps` object covering every store
  write, the probe, and session reads.

# Image agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/image --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3`: read `error.plan` — provider/model/size are what would be billed.
   Confirm and re-run with `--execute`.
4. Exit `1` with `No image provider configured`: pass `--provider openai|gemini`
   or set `image_provider` on the agent/instance/default settings.
5. Artifact stuck in `pending` after `--execute`: check the worker args include
   `--execute` (see `worker_started` event payload pid, then daemon logs) — a
   worker without the flag exits 3 silently.
6. If a generate billed without `--execute`, the brake regressed: check that
   `contractDryRun` runs before `createArtifact`/`spawnDetachedCli` in
   `src/cli/commands/image.ts`.

## Validation

```bash
bun test src/cli/commands/image-contract.test.ts
bun test src/cli/commands/image.test.ts
```

Live checks:

```bash
ravi image generate "gato roxo" --json               # expect exit 3 + plan
ravi image generate "gato roxo" --json --execute     # queues artifact (bills!)
ravi image atlas split /tmp/atlas.png --cols 3 --rows 2 --json   # unbraked local op
```

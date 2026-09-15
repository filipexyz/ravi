# Image agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/image --mode rules --json`.
2. Reproduce with `--json` and read `error.code` first.
3. Exit `3`: the command plans external delivery. Review the safe target
   presence, basename/directory mode and generation facts, then re-run with
   `--execute` if approved.
4. Exit `1` with `No image provider configured`: pass `--provider openai|gemini`
   or set `image_provider` on the agent/instance/default settings.
5. Artifact stuck in `pending` on an approved delivery: check that the worker
   args inherited `--execute` (see `worker_started`, then daemon logs).
6. If a delivery proceeds without `--execute`, check the conditional
   `contractDryRun` before artifact/split/provider/sender work.

## Validation

```bash
bun test src/cli/commands/image-contract.test.ts
bun test src/cli/commands/image.test.ts
```

Live checks:

```bash
ravi image generate "gato roxo" --json               # queues generation directly
ravi image generate "gato roxo" --send --json        # expect exit 3 + delivery plan
ravi image generate "gato roxo" --send --json --execute # queues and sends
ravi image atlas split /tmp/atlas.png --cols 3 --rows 2 --json   # unbraked local op
```

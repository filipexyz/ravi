# Image agent-first CLI contract / CHECKS

## Checks

- `image generate "<prompt>" --json` without a delivery target MUST run without
  `--execute` (async by default; `--sync` calls the provider inline).
- A generate run that will deliver MUST exit 3 without `--execute` before
  artifact, worker, provider and sender side effects.
- Generate and atlas delivery plans MUST NOT contain prompt/caption bytes;
  secret markers at the beginning or end MUST be absent from the envelope.
- Internal worker args MUST include `--execute` only for approved delivery.
- Provider-resolution failures (`No image provider configured`) and the
  `--async`+`--sync` conflict, missing local input/source and missing delivery
  target MUST fail with exit 1 BEFORE the brake.
- `image atlas split` MUST run immediately without `--send`; with `--send`, it
  MUST require `--execute` before splitting, artifacts and delivery.
- The `sendCommand` field of each generated image MUST read
  `ravi media send "<path>" --execute`.
- `bun test src/cli/commands/image-contract.test.ts` SHOULD pass after any
  change to the image contract surface.

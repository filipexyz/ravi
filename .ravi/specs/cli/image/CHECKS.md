# Image agent-first CLI contract / CHECKS

## Checks

- `image generate "<prompt>" --json` without `--execute` MUST exit 3 with
  `dryRun: true` and a `plan` showing the resolved provider/model/mode/size,
  and MUST NOT create an artifact, spawn a worker or call any provider.
- `image generate "<prompt>" --json --execute` MUST run (async by default,
  returning `artifact_id`; with `--sync` it calls the provider inline).
- The internal worker args spawned by the async path MUST include `--execute`.
- Provider-resolution failures (`No image provider configured`) and the
  `--async`+`--sync` conflict MUST fail with exit 1 BEFORE the brake.
- `image atlas split` MUST keep immediate (unbraked) execution as declared.
- The `sendCommand` field of each generated image MUST read
  `ravi media send "<path>" --execute`.
- `bun test src/cli/commands/image-contract.test.ts` SHOULD pass after any
  change to the image contract surface.

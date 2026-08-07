# Watch CLI / CHECKS

## CLI Checks

```bash
ravi watch connectors --json
ravi watch list --json
```

Expected:

- output contains no provider tokens;
- connectors list includes placement support;
- npm and GitHub expose supported event types.

## Creation Checks

Create npm and GitHub watches.

Expected:

- watch id is returned;
- connector config is normalized;
- placement is explicit in JSON;
- event subjects are returned;
- no trigger is created unless requested.
- GitHub auto placement calls Console capabilities before choosing placement.
- Missing GitHub App installation returns an actionable install/connect hint,
  not silent local fallback.

## Trigger Helper Checks

Run `ravi watch trigger ... --execute` from a chat context.

Expected:

- created record is visible in `ravi triggers show`;
- topic is a `ravi.watch...` subject;
- filter scopes to the watch id;
- reply source points at the current chat.

## Agent-First Contract Checks

- `watch show <unknown-id> --json` MUST exit 1 with the `WATCH_NOT_FOUND`
  envelope and up to three `suggestions` of real watch ids/names/resources.
- An invalid flag on any `watch` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `watch rm <id>` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with the removal `plan`, and MUST NOT delete anything (local or console);
  with `--execute` the removal MUST happen.
- `watch trigger <id> --message ...` without `--execute` MUST exit 3 with a
  plan showing the resolved watch and the exact trigger record, and MUST NOT
  create the trigger; with `--execute` the trigger MUST be created.
- `watch run <id> --once` without `--execute` MUST exit 3 and MUST NOT start a
  poll cycle.
- `watch run <id> --once --execute` without local runner support MUST emit
  `LOCAL_RUNNER_NOT_IMPLEMENTED` with exit 1 in text and JSON, never an
  `ok:false` success payload.
- Validation on `trigger`/`run` (missing `--message`, unknown watch, unknown
  `--agent`, non-local placement) MUST fail before any dry-run plan is emitted.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — `runWatchCommand` MUST rethrow `ContractError`
  unchanged. Stable provider errors MUST use exit 1 with only allowlisted
  details; unexpected errors MUST become redacted `UNHANDLED_ERROR`.
- `watch list --fields a,b,c --json` MUST return items containing only the
  requested fields.
- Unbraked writes (`create`, `enable`, `disable`) MUST keep immediate-write
  behavior as declared in the spec; there is no shipped `watch` skill (gap
  registered in SPEC.md), so the `create` output hint teaching `watch trigger`
  MUST carry `--execute`.
- The contract suite `bun test src/cli/commands/watch.test.ts` SHOULD pass
  after any change to this surface.

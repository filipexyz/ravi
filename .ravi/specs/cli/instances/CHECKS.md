# Instances & routes agent-first CLI contract / CHECKS

## Checks

- `instances show|get|set|delete <unknown> --json` and the route/pending ops on
  an unknown instance MUST exit 1 with the `INSTANCE_NOT_FOUND` envelope and up
  to three `suggestions` of real instance names/omni instanceIds.
- `routes show` and `instances routes show|remove|set` on an unknown pattern
  MUST exit 1 with the `ROUTE_NOT_FOUND` envelope and up to three `suggestions`
  from that instance's real patterns.
- An invalid flag on any migrated op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `instances delete` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the resolved instance in `plan`, and MUST NOT soft-delete
  anything; with `--execute` the soft-delete MUST happen.
- `instances routes remove` without `--execute` MUST exit 3 with pattern +
  instance + agent in `plan` and MUST NOT delete the route; with `--execute`
  the route MUST be removed.
- `instances pending reject` without `--execute` MUST exit 3 with the resolved
  pending entry in `plan` and MUST NOT remove it; with `--execute` the entry
  MUST be removed.
- The brake on any braked op MUST fire only after instance/route resolution and
  the runtime-mismatch check, and MUST fire before any db write or
  `ravi.config.changed` emission.
- `instances list --fields a,b,c --json` and `routes list --fields a,b,c
  --json` MUST return items containing only the requested fields in both
  duplicated payload arrays.
- Unbraked writes listed in the spec (including `connect` and `routes add`)
  MUST keep immediate-write behavior, and the shipped `instances` and `routes`
  skills MUST list them explicitly as unbraked.
- `instances disable` with an unknown target MUST keep the ignore-instanceId
  behavior and MUST NOT emit `INSTANCE_NOT_FOUND`.
- `bun test src/cli/commands/routes.test.ts` SHOULD pass after any change to
  the instances/routes contract surface.

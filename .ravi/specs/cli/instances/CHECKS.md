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
- A timed-out `instances connect` MUST reject with `INSTANCE_CONNECT_TIMEOUT`,
  exit 1, and `retryable: true` in text and JSON; it MUST NOT fall through to
  `UNHANDLED_ERROR` or call `process.exit` from the timer.
- `instances delete` and `instances routes remove` MUST soft-delete immediately
  without `--execute`, remain `kind: "mutate"`, and be recoverable through
  their existing restore commands.
- `instances pending reject` without `--execute` MUST exit 3 with instance,
  pending kind and contact/phone/chat/name presence flags in `plan`; personal
  data values MUST NOT appear and the entry MUST NOT be removed. With
  `--execute` the entry MUST be removed.
- The `pending reject` brake MUST fire after instance/entry resolution and
  before any DB write. Route removal MUST enforce the runtime-mismatch check
  before its immediate DB write and `ravi.config.changed` emission.
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
- `bun test src/cli/commands/instances-pending.test.ts` MUST verify that a Slack
  pending group retains its complete lowercase id in the listed and approved
  pattern; raw ids, lowercase ids and the listed `group:` pattern select the
  same entry. Approval must persist a route that the real resolver matches,
  satisfy Slack's explicit-route predicate and report `verified: true` through
  `routes explain`.
- Two Slack ids sharing all digits MUST remain distinct during pending lookup.
  An id without digits and a pending entry without `chatId` MUST still work.
- Repeated explicit approval MUST be idempotent. Approval after a legacy
  truncated route consumed the pending entry MUST create the full route
  without silently renaming or removing the old numeric route.
- WhatsApp numeric groups, group JIDs (including hyphens), prefixed groups and
  formatted phone approvals MUST retain their normalization and review kind.

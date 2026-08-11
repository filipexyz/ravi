# Hooks agent-first CLI contract / CHECKS

## Checks

- `hooks show <unknown-id> --json` MUST exit 1 with the `HOOK_NOT_FOUND`
  envelope and up to three `suggestions` of real hook ids/names.
- An invalid flag on any `hooks` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `hooks rm <id>` without `--execute` MUST exit 3, MUST report `dryRun: true`
  with the deletion `plan`, and MUST NOT delete the hook nor emit a hook
  refresh; with `--execute` the deletion and the refresh MUST happen.
- Hook dry-run plans MUST contain only the hook id, action/scope types, and the
  deletion enabled flag; names, event names, and complete scope values MUST be
  absent.
- The `rm` aliases (`delete`, `remove`) MUST inherit the same brake — no alias
  bypasses `--execute`.
- `hooks enable`/`hooks disable` on an unknown id MUST exit 1 with
  `HOOK_NOT_FOUND` and MUST NOT write anything.
- `hooks test <unknown-id> --json` MUST return the `HOOK_NOT_FOUND` envelope
  instead of an unhandled `runHookById` throw.
- `hooks test` for `inject_context` or `send_session_event` MUST exit 3 without
  `--execute` and MUST NOT deliver to a session; other action types MUST remain
  immediate. Both branches MUST be covered.
- `hooks list --fields a,b,c --json` MUST return items containing only the
  requested fields.
- Unbraked writes (`create`, `enable`, `disable`) MUST keep immediate-write
  behavior as declared in the spec; the `hooks list` usage output MUST teach
  `rm` with `--execute`.
- The contract suite `bun test src/cli/commands/hooks.test.ts` SHOULD pass
  after any change to this surface.
- A shipped `hooks` skill does not exist yet; when one is added it SHOULD
  document the brake on `rm` and the unbraked ops explicitly.

# Threads agent-first CLI contract / CHECKS

## Checks

- `threads show <unknown-ref> --json` MUST exit 1 with the `THREAD_NOT_FOUND`
  envelope and up to three `suggestions` of real thread ids/slugs/titles,
  even though `resolveThread` throws on unknown refs.
- `threads comment|note|link|entries|brief|close` on an unknown ref MUST exit
  1 with `THREAD_NOT_FOUND` and MUST NOT write anything.
- An ambiguous slug across scopes MUST keep the `COMMAND_FAILED`
  compatibility envelope (exit 1, no `THREAD_NOT_FOUND` code) instead of
  suggesting threads for a ref that matches more than one.
- `threads list --fields a,b,c --json` MUST return items containing only the
  requested fields.
- Every threads write (`create`, `comment`, `note`, `link`, `close`) MUST
  keep immediate-write behavior — the domain is declared brake-free and no op
  may exit 3.
- An invalid flag on any `threads` op SHOULD exit 2 with `acceptedFlags`.
- `bun test src/cli/commands/threads.test.ts` SHOULD pass after any change to
  the threads contract surface.

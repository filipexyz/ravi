# Ravi Commands agent-first CLI contract / CHECKS

## Checks

- `commands show <unknown> --json` and `commands run <unknown> --json` MUST
  exit 1 with the `COMMAND_NOT_FOUND` envelope and up to three `suggestions`
  of real command ids from the same registry the lookup used.
- Any commands op given an unknown `--agent` MUST exit 1 with
  `AGENT_NOT_FOUND` and suggestions from the local agent config, before any
  filesystem discovery runs.
- `commands list --fields a,b,c --json` MUST return `items` (and `commands`)
  containing only the requested fields.
- `commands run` MUST remain a pure renderer: it returns the composed prompt
  and MUST NOT publish to any session or emit runtime side effects.
- No commands op may exit 3 — the domain is declared brake-free.
- `commands validate` MUST keep its pre-existing exit-1 verdict when command
  files carry validation errors; that exit is not renamed to a contract code.
- The shipped `commands` skill MUST document the contract (envelope, exits,
  `--fields`, absence of brakes) in its `## Contrato Do CLI` section.
- An invalid flag on any `commands` op SHOULD exit 2 with `acceptedFlags`.
- `bun test src/cli/commands/commands.test.ts` SHOULD pass after any change
  to the commands contract surface.

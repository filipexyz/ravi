# Heartbeat agent-first CLI contract / CHECKS

## Checks

- `heartbeat show <unknown-agent> --json` MUST exit 1 with the
  `AGENT_NOT_FOUND` envelope and up to three `suggestions` of real agent
  ids/names.
- `heartbeat enable|disable|set|trigger` on an unknown agent MUST exit 1 with
  `AGENT_NOT_FOUND` and MUST NOT write config nor publish any prompt.
- An invalid flag on any `heartbeat` op MUST exit 2 with `acceptedFlags` in
  the envelope.
- No `heartbeat` op MUST ever exit 3 or accept `--execute`: the domain
  declares zero braked ops (trigger is the agent's own benign heartbeat;
  enable/disable/set are reversible) — adding a brake here is a contract
  regression, not a fix.
- `heartbeat trigger <agent>` without any extra flag MUST fire the heartbeat
  (or return `status: "skipped"` on missing/empty `HEARTBEAT.md`) with exit 0.
- `heartbeat status --fields a,b,c --json` MUST return items containing only
  the requested top-level fields.
- The shipped `heartbeat` skill MUST document the no-brake declaration and the
  envelope/exit/`--fields` contract.
- The contract suite `bun test src/cli/commands/heartbeat.test.ts` SHOULD pass
  after any change to this surface.

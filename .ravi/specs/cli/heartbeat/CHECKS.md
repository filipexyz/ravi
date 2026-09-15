# Heartbeat agent-first CLI contract / CHECKS

## Checks

- `heartbeat show <unknown-agent> --json` MUST exit 1 with
  `AGENT_NOT_FOUND` and live suggestions.
- `heartbeat enable|disable|set|trigger` on an unknown agent MUST NOT write
  config or publish a prompt.
- Invalid flags MUST exit 2 with `acceptedFlags`.
- A missing or empty `HEARTBEAT.md` MUST return `skipped`, exit 0, without
  requiring `--execute`.
- Pending heartbeat work without `--execute` MUST exit 3 before session
  lookup or prompt publication.
- The same pending work with `--execute` MUST publish exactly one prompt.
- `heartbeat status --fields ... --json` MUST return only requested fields.
- AGENTS, the shipped heartbeat skill and CLI guides MUST show `--execute`
  for a manual trigger that queues work.
- `bun test src/cli/commands/heartbeat.test.ts` and
  `bun test src/cli/execute-consumers.test.ts` SHOULD pass after changes.

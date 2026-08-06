# WhatsApp agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/whatsapp --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `GROUP_NOT_FOUND`: read `error.suggestions` — real group ids and
   subjects from the same listing the resolution used. Retry with one of them,
   or run `ravi whatsapp group list --json` to see everything.
4. Exit `1` + `CONTACT_NOT_FOUND`: the target is not a known contact. Read
   `error.suggestions` (local contacts DB); register the contact first
   (`ravi contacts add`) — only known contacts can join groups.
5. Exit `3`: read `error.plan`, confirm the message/membership change is really
   intended for those real people, then re-run the same command adding
   `--execute`.
6. If a braked op reached WhatsApp without `--execute`, the brake regressed:
   check the op still calls `contractDryRun` BEFORE any provider/NATS call
   (`group send` must brake before even the group-metadata read), and that the
   registry dispatcher still maps `ContractError.exitCode`.
7. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   the registry dispatcher lost the `ContractError` branch — see
   `src/cli/registry.ts`.
8. Unknown-flag errors still print commander's default text (exit 1) on this
   domain: the `whatsapp` group is not yet in `AGENT_CONTRACT_DOMAINS`
   (`src/cli/index.ts`). That is a known gap, not a per-op regression.

## Validation

```bash
bun test src/cli/commands/group.test.ts
bun tsc --noEmit
```

Live checks against the local CLI (dry-run only unless you really mean it;
use an isolated `RAVI_STATE_DIR` and a test group):

```bash
ravi whatsapp group info nope --json                     # expect exit 1 + GROUP_NOT_FOUND + suggestions
ravi whatsapp group send <jid> "test" --json             # expect exit 3 + dryRun plan, nothing delivered
ravi whatsapp group remove <jid> "5511000000000" --json  # expect exit 3, nobody removed
ravi whatsapp dm send <contact> "test" --json            # expect exit 3 + dryRun plan
ravi whatsapp group list --fields id,subject --json      # expect compact items
```

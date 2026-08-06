# Chats agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/chats --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `CHAT_NOT_FOUND`: read `error.suggestions` — real chat ids,
   titles, and normalized chat ids similar to what was asked. Retry with one of
   them, or narrow with `--instance` / `--channel`.
4. Exit `1` + `READING_LIST_NOT_FOUND`: read `error.suggestions` — real list
   ids/names (owner-filtered when `--owner` was passed). `show`, `preview`, and
   `recompute` additionally require the canonical `crl_<24 hex>` id from
   `ravi chats lists list`.
5. Exit `1` + `CONTACT_NOT_FOUND`: no suggestions by design (contacts are
   scope-filtered in their own domain); list with `ravi contacts list --json`.
6. Exit `3`: read `error.plan` (list id, list name, chat id), confirm the
   removal is intended, then re-run the same command adding `--execute`.
7. If `chats lists remove` removed a member without `--execute`, the brake
   regressed: check the op still calls `contractDryRun` after ref validation
   and before `dbRemoveChatFromReadingList`.
8. `chats backfill-provider-timestamps` and `chats lists recompute` are NOT
   `--execute` ops: the first writes only with `--apply`, the second is gated by
   `chats lists preview` plus the selector safety gate. Do not "fix" them by
   renaming flags.
9. If a braked op exits 1 with `Error: ...` text when `RAVI_*` envs are set,
   the registry dispatcher lost the `ContractError` branch — see
   `src/cli/registry.ts`.
10. If an invalid flag on a `chats` op exits 1 with plain text instead of 2
    with the envelope, that is the known gap: `"chats"` is not yet listed in
    `AGENT_CONTRACT_DOMAINS` in `src/cli/index.ts`.

## Validation

```bash
bun test src/cli/commands/chats.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi chats read chat_ffffffffffffffffffffffff --json     # expect exit 1 + suggestions
ravi chats lists members no-such-list --json             # expect exit 1 + suggestions
ravi chats lists remove <list> <chat> --json             # expect exit 3 + dryRun plan
ravi chats lists remove <list> <chat> --json --execute   # expect removal
ravi chats list --fields messageCount --json             # expect compact items
ravi chats backfill-provider-timestamps --json           # expect dryRun: true
```

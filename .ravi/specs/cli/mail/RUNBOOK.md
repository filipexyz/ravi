# Mail agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/mail --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `ACCOUNT_NOT_FOUND`/`MAILBOX_NOT_FOUND`: read
   `error.suggestions` — real account ids or mailbox addresses similar to what
   was asked. Retry with one of them.
4. Exit `1` + `MESSAGE_NOT_FOUND`/`OUTBOX_NOT_FOUND`/`THREAD_NOT_FOUND`: these
   ids are opaque; run the listing command from `error.suggestedAction` and
   copy the exact id.
5. Exit `3`: read `error.plan` (from/to/subject/bodyPreview), confirm the
   e-mail is intended, then re-run the same command adding `--execute`.
6. If a send/reply reached the outbox (or a provider) without `--execute`, the
   brake regressed: check the op still calls `contractDryRun` before
   `enqueueMailSend`/`enqueueMailReply`/`sendRemoteMail`/`execCapability`, and
   for `gmail send` that it fires before `resolveDefaultGoogleConnector`.
7. If a braked op exits 1 with a `PAYLOAD_INVALID`-style cloud error when
   `RAVI_*` envs are set, the `ContractError` rethrow in
   `runMailCommand`/`runGmailCommand` was lost — see
   `src/cli/commands/mail.ts` / `gmail.ts`.
8. Usage errors (unknown flag) still exit 1 with commander text: `mail`/`gmail`
   are not yet in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`) — that is the
   pending registration, not a per-op bug.

## Validation

```bash
bun test src/cli/commands/mail.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi mail send --to a@b.c --subject s --body b --json      # expect exit 3 + dryRun plan
ravi mail reply <message-id> --body ok --json              # expect exit 3 + dryRun plan
ravi mail mailboxes show nope@nope --json                  # expect exit 1 + suggestions
ravi mail messages read msg-nope --json                    # expect exit 1 + suggestedAction
ravi mail accounts list --fields id,provider --json        # expect compact items
ravi gmail send --to a@b.c --subject s --body b --json     # expect exit 3, no connector lookup
```

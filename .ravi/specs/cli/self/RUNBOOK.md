# Self agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/self --mode rules --json`.
2. Read `ravi self --help`; it declares env names, source precedence,
   degradation, schemas and exit codes without exposing env values.
3. Start compact: `ravi self context --fields identity,session --json`. Only
   widen to the full packet when a section is actually needed.
4. `SELF_CONTEXT_REQUIRED`: inspect `ravi context whoami --json` and select or
   issue a valid credential. `SELF_CONTEXT_UNAVAILABLE`: refresh the referenced
   context and retry.
5. A section with `status: partial|missing|unavailable` is healthy degraded
   data, not a command failure. Read its `reason` and source/trust fields.
6. An env-sourced actor is intentionally `partial` and `unverified`; do not use
   it as an authorization decision.
7. Exit 2 `USAGE_ERROR` on `--fields`: retry with `error.acceptedFields`.
8. `recent` empty: confirm the chat binding (`ravi self chat --json`) — recent
   lookup needs a chat id from binding, chat record, or source fallback.
9. If any `self` op ever writes (context `lastUsedAt` changes, DB rows touched)
   the read-only invariant regressed — check `resolveRuntimeContextOrThrow`
   still receives `{ touch: false, readOnly: true }`.
10. Secrets in output: metadata keys matching key/token/secret/password/
   credential must print as `[redacted]`; the raw context key must never
   appear.
11. Inspect a concrete schema with
    `ravi sdk returns show self.<command> --json`.

## Validation

```bash
bun test src/cli/commands/self.test.ts
bun test src/runtime/runtime-operational-context.test.ts
bun test src/sdk/client-codegen/return-schema-coverage.test.ts
```

Live checks (read-only by construction; any session context works):

```bash
ravi self whoami --json
ravi self context --fields identity,session --json   # expect only 2 sections
ravi self context --json                             # expect full packet
ravi self recent --limit 5 --json                    # expect at most 5 rows
ravi self explain --json                             # expect env contract step
```

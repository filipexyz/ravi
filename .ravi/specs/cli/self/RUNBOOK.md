# Self agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/self --mode rules --json`.
2. Start compact: `ravi self context --fields identity,session --json`. Only
   widen to the full packet when a section is actually needed.
3. `Missing RAVI_CONTEXT_KEY` / "Failed to resolve context": the caller is not
   running inside a Ravi session context. Check the environment (`RAVI_*`
   envs) or pass through a session (`ravi sessions send ... "ravi self whoami"`).
4. A section with `status: missing|partial` is data, not an error — read its
   `reason`. Follow-ups live in `nextReads` inside the payload.
5. `recent` empty: confirm the chat binding (`ravi self chat --json`) — recent
   lookup needs a chat id from binding, chat record, or source fallback.
6. If any `self` op ever writes (context `lastUsedAt` changes, DB rows touched)
   the read-only invariant regressed — check `resolveRuntimeContextOrThrow`
   still receives `{ touch: false, readOnly: true }`.
7. Secrets in output: metadata keys matching key/token/secret/password/
   credential must print as `[redacted]`; the raw context key must never
   appear.

## Validation

```bash
bun test src/cli/commands/self.test.ts
```

Live checks (read-only by construction; any session context works):

```bash
ravi self whoami --json
ravi self context --fields identity,session --json   # expect only 2 sections
ravi self context --json                             # expect full packet
ravi self recent --limit 5 --json                    # expect at most 5 rows
```

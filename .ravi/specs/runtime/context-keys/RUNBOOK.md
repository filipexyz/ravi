# Runtime Context Keys Runbook

## Inspect Current Contexts

```bash
ravi context list --kind agent-runtime --json
ravi context list --agent dev --kind agent-runtime --json
ravi context info <context-id> --json
```

Use `lastUsedAt ?? createdAt` as the operational last-seen timestamp.

## Verify Session Reuse

1. Send multiple turns to the same Ravi session.
2. List contexts for that session:

```bash
ravi context list --session <session-key> --kind agent-runtime --json
```

3. Confirm there is one live `agent-runtime` context for that session.
4. Confirm `contextId` stays stable and `lastUsedAt` advances after each turn.
5. Confirm `capabilities` do not change unless the session context is revoked and a new dispatch creates a fresh context.

## Cleanup Historical Turn-Scoped Contexts

Cleanup is dry-run by default:

```bash
ravi context cleanup-agent-runtime --older-than 1h --json
```

To revoke matching stale contexts after reviewing the candidates:

```bash
ravi context cleanup-agent-runtime --older-than 1h --reason cleanup_old_turn_scoped_contexts --revoke
```

Useful filters:

```bash
ravi context cleanup-agent-runtime --agent dev --older-than 1h --json
ravi context cleanup-agent-runtime --session <session-key> --older-than 15m --json
```

The command only targets live `agent-runtime` contexts older than the threshold. It does not revoke `admin-bootstrap` or child `cli-runtime` contexts directly; normal context revocation cascades to descendants when a selected parent is revoked.

## Reset Or Abort

After `ravi sessions reset <session>`, the session should have no live `agent-runtime` context from before the reset:

```bash
ravi context list --session <session-key> --kind agent-runtime --json
```

The next dispatch should create one fresh context with a new capability snapshot.

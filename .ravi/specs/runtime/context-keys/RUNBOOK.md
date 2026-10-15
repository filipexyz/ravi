# Runtime Context Keys Runbook

## Inspect Current Contexts

```bash
ravi context list --kind turn-runtime --json
ravi context list --agent dev --kind turn-runtime --json
ravi context info <context-id> --json
```

Use `lastUsedAt ?? createdAt` as the operational last-seen timestamp.

## Verify Agent Identity Dispatch

1. Send multiple turns to the same Ravi session.
2. List contexts for that session:

```bash
ravi context list --session <session-key> --kind turn-runtime --json
```

3. Confirm new contexts use `kind=turn-runtime`.
4. Confirm metadata has `authorityMode=agent-identity`.
5. Confirm no new live `agent-runtime` context is created by dispatch.
6. Confirm external unresolved actors receive no tool authority, while internal
   workspace prompts use `agent_identity:<agent>:workspace:default`.

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
ravi context list --session <session-key> --kind turn-runtime --json
```

The next dispatch should create a fresh `turn-runtime` context with
`authorityMode=agent-identity`.

## Context Keys At Rest

`ravi.db` stores only a digest of each context key (`kh1:` + base64url of
its SHA-256). The daemon hashes rows written in plaintext by an older Ravi
when it boots and logs `Stored legacy context keys as digests` with the
count. Check the state:

```bash
ravi doctor --json | jq '.checks[] | select(.id == "runtime.context_keys_at_rest")'
```

`plaintextContextKeys > 0` means the daemon has not booted on this version
yet (or the migration failed; see the daemon log). Fix:

```bash
ravi daemon restart -m "hash context keys"
```

Lookups keep accepting plaintext rows until then, so agents do not lose
authority while the warning is shown. Boot runs the migration inside a
write transaction and may wait up to ~30 s for the SQLite write lock (the
`busy_timeout` across the retry attempts) if another writer holds it; after
that it logs `Could not store legacy context keys as digests; lookups still
accept them` and continues with plaintext lookups. The next restart tries
again.

### Plaintext rows that survive a restart

A row still in plaintext after the daemon has booted on this version is a
plaintext twin of a key that already exists as a digest. The migration skips
it (logged as `Some legacy context keys were left in plaintext ...` with
`skippedContextIds`), lookups never prefer it over the digest row, and it
only arises from editing `ravi.db` by hand. `ravi doctor` lists the ids in
`plaintextContextIds` (at most 20; `plaintextContextIdsTruncated` says
whether more exist). Revoke each one:

```bash
ravi context revoke <id> --reason plaintext_twin
```

If `plaintextContextIdsTruncated` is true, run the doctor again after
revoking the listed ids to get the next batch.

### Rolling back to a version that compares plaintext

Digests are irreversible. A Ravi that looks keys up by plaintext does not
recognize any migrated key:

- Turn and child contexts need no action: the next turn issues new ones.
- SDK clients and child CLIs that hold an `rctx_*` key from before the
  rollback get `Context not found` until they receive a new key.
- The admin bootstrap key: revoke the migrated admin context
  (`ravi context revoke <id>`), then re-import the key from the old
  install's `RAVI_BOOTSTRAP_KEY` with `ravi daemon init-admin-key --from-env`,
  or issue a new one with `ravi daemon init-admin-key`.

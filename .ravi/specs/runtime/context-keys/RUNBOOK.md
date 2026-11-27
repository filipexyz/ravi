# Runtime Context Keys Runbook

## Inspect Current Contexts

```bash
ravi context list --kind turn-runtime --json
ravi context list --agent dev --kind turn-runtime --json
ravi context info <context-id> --json
```

Use `lastUsedAt ?? createdAt` as the operational last-seen timestamp.

For a long-turn authentication failure, compare the rejected context's
`expiresAt` with the command timestamp and the turn terminal timestamp. Touching
a context only updates `lastUsedAt`. An active host-owned turn renews before
expiry after authority revalidation; a completed turn is revoked immediately.
An expired bearer returns `CONTEXT_EXPIRED` (401), including on open command
routes; a valid bearer lacking a capability returns `PERMISSION_DENIED` (403).
Do not widen grants or reset the session to treat credential expiry.
Narrowed relays (`metadata.relayNarrowing=true`), derived children and bridge
delegations retain their original bounded lifetime; the active-turn lease does
not renew them. For these contexts, the next turn must issue fresh authority.

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

## Measure Active-Context Lookup

Use synthetic history in an isolated state directory; never copy production
credentials into a benchmark fixture:

```bash
RAVI_STATE_DIR="$(mktemp -d)" bun scripts/benchmark-active-contexts.ts
```

The script creates and removes its own isolated database with 25,000 expired
contexts and six active records. It captures the current production query,
compares every returned column with the legacy query, alternates seven runs of
each, and reports plans, failures, medians, ranges and machine load. The reported
times cover SQL materialization with a warmed cache, not end-to-end replies.
Expiry-index candidate lookup should replace the creation-order history scan;
do not translate its speedup into the same multiplier for the entire runtime.

## Keys stored as hashes (migration, rotation, rollback)

- At schema initialization the registry replaces every clear key in `contexts.context_key` with its SHA-256, zeroes the freed bytes (`secure_delete`) and truncates the WAL. The daemon log line `Hashed stored context keys` reports how many rows changed and how many are still live.
- Copies of the state database made before that boot (update rollback snapshots, manual backups) still hold those keys in the clear, and the keys stay valid so paired devices and operator credentials keep working. Once those copies are gone (the next `ravi update` prunes the old snapshot), rotate the long-lived ones: `ravi context revoke <contextId>`, then issue a new key the usual way (`ravi daemon init-admin-key` for the admin bootstrap key, pairing again for a voice device).
- Code-only rollback to a release without hashing: that release looks keys up in the clear and no longer finds the migrated rows, while `init-admin-key` still counts them as live and refuses. Revoke the admin bootstrap contexts by id (`ravi context revoke <contextId>`, which works on the old release) and run `ravi daemon init-admin-key` again. A managed rollback (`ravi update rollback`) restores the pre-update database and needs none of this.
- The migration runs in the first process of the new release that opens the database, which can be a CLI before the old daemon restarts. From that moment the old daemon and channels runner no longer find keys (they look them up in the clear) until they restart. Restart both right after installing the release (`ravi update` does; after a manual install, `ravi daemon restart` and `ravi channels restart` at once).
- The migration truncates the WAL. If another process held the database, the log line reports `walCheckpointBusy: true` and the daemon retries the truncate a few times in the background. To confirm nothing is left: `strings ~/.ravi/ravi.db ~/.ravi/ravi.db-wal | grep -c rctx_` should print 0 once the daemon is the only process using the database.
- Out of scope of the hashing: `~/.ravi/credentials.json` (the operator's own credential) and `~/.ravi/.env` keep secrets in the clear, mode 0600, readable by any process of the same OS user. A reader of the disk (a Codex sandbox) can still take the operator credential from there.

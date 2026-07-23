# Ravi Doctor Runbook

## Basic Usage

Run the compact human report:

```bash
ravi doctor
```

Run the full human report:

```bash
ravi doctor --full
```

Run typed output for agents, CI, or scripts:

```bash
ravi doctor --json
```

Run one domain when supported:

```bash
ravi doctor --domain permissions --json
ravi doctor --domain costs --json
ravi doctor --domain routes --json
```

## Triage Order

1. Fix `error` findings first.
2. Review `warn` findings when they affect the current workstream.
3. Use `info` findings only for context, coverage, and snapshots.

## Disk And Temp Pressure Findings (`runtime.disk_space_low`)

`ravi doctor` measures free space and writability for the working directory,
the OS temp directory, and the Ravi state dir. It is read-only: it never
deletes, prunes, vacuums, or cleans anything. When it reports `warn`/`error`,
free space with an operator-approved cleanup — no automated cleanup daemon or
self-pruning is added by this check.

Inspect the finding first:

```bash
ravi doctor --domain runtime --json
```

Then confirm host usage with read-only tools before touching anything:

```bash
# Where is the pressure? (per filesystem)
df -h

# Largest space consumers under the home tree (read-only survey)
du -xhd1 "$HOME" 2>/dev/null | sort -h | tail -40
du -xhd1 "$HOME/.ravi" 2>/dev/null | sort -h | tail -40
```

### Safe Cleanup Plan (requires explicit human approval)

Every command below is destructive and MUST NOT be run automatically or by an
agent. A human operator reviews the survey above, then decides. Prefer moving
to cold storage over deletion when in doubt. Ravi state directories, databases,
attachments, artifacts, worktrees, and models MUST NOT be deleted or moved as
part of routine cleanup.

Candidate, lowest-risk-first (each needs sign-off and a fresh `df -h` check
before and after):

1. Rotated/rebuildable caches outside Ravi state (package managers, build
   caches) — safe to clear because they are regenerated on demand.
2. Old daemon log files under `~/.ravi/logs/` once captured/rotated — review
   before removing; keep the current log.
3. OS temp leftovers from crashed processes in the temp dir — only files the
   operator can attribute to dead processes.

Never in scope for automated or routine cleanup: `~/.ravi/ravi.db`,
`insights.db`, JetStream storage, artifacts, attachments, models, and agent
working directories. Removing these loses durable operational state.

After an approved cleanup, re-run `ravi doctor --domain runtime --json` to
confirm the finding cleared.

If the host is so full that validation commands themselves fail, report that
explicitly (e.g. `df -h` shows `100%`) rather than hiding it, and escalate for
approved manual cleanup.

## Permissions Findings

If doctor reports broad or permanent grants:

1. Inspect the subject and object.
2. Confirm whether the grant is legacy/bootstrap state or newly created.
3. Prefer a scoped temporary grant for new authorization.
4. Do not mass revoke broad grants without checking active agents and sessions.

If doctor reports a mutating command without permission metadata:

1. Add explicit command registry metadata for mutation/risk/permission.
2. Add or tighten the permission guard.
3. Add a focused test that verifies denied execution from an agent context.

## Costs Findings

If doctor reports unpriced usage:

1. Check whether the provider/model exists in the pricing catalog.
2. Add an alias or catalog entry when the model is real.
3. Recompute or backfill cost rows only with an explicit repair command.

If doctor reports stale pricing:

1. Confirm the catalog cache age.
2. Refresh the LiteLLM-derived catalog if network access is healthy.
3. Keep the local fallback deterministic.

## Routes And Sessions Findings

If doctor reports a route pointing to a missing agent:

```bash
ravi routes list --json
ravi agents show <agent> --json
```

Then either recreate the missing agent or remove/update the route with an
explicit route command.

If doctor reports chats without routes, confirm whether those chats are meant
to be passive, muted, or unowned before creating routes.

## Channels And Omni Findings

If doctor reports a disconnected enabled instance:

```bash
ravi instances list --json
ravi instances show <instance> --json
```

Then inspect Omni/provider health through the channel-specific read-only
diagnostics.

If doctor reports unresolved inbound actor/contact metadata:

1. Inspect recent message metadata.
2. Confirm platform identity resolution.
3. Fix the identity graph path, not the raw channel id in routing code.

## Specs, Apps, And Skills Findings

If doctor reports draft specs applying to production code:

1. Review whether the spec is still draft or should be promoted.
2. Keep draft status if the production code is experimental.
3. Promote only after the invariant is stable.

If doctor reports a skill referencing a missing spec:

1. Fix the skill reference or create the missing spec.
2. Re-run `ravi specs sync --json`.

If doctor reports app registry drift:

1. Run `ravi apps check --json`.
2. Distinguish valid local state from missing repo registry metadata.
3. Fix the registry only when the app should be in source control.

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

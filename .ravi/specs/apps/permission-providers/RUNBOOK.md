# App Permission Providers / RUNBOOK

## Add A Provider To An App

1. Read the app and permission parent specs:

   ```bash
   ravi specs get apps/permission-providers --mode rules --json
   ravi specs get apps/manifest --mode rules --json
   ravi specs get apps/router --mode rules --json
   ravi specs get permissions --mode rules --json
   ```

2. Define the app-owned resources and actions. Do not start with relations.
   Start with examples:

   ```text
   resource: calendar:<id>
   actions: read, create_event, update_event, delete_event
   owners: contact:<id>, team:<id>, system:*
   ```

3. Decide which required provider-runtime decisions gate the app:

   - app discovery intent: `use app:<app-id>`
   - app mutation intent: `execute app:<app-id>`
   - agent ceiling
   - break-glass
   - provider-owned grant lifetime/revocation/audit

4. Add `permissions.provider` metadata to the manifest.

5. Implement a provider operation that accepts
   `ravi.app.permission.request/v1` and returns
   `ravi.app.permission.decision/v1`.

6. Add tests before routing production operations through the provider:

   - allow owner;
   - deny non-owner;
   - deny unresolved actor;
   - deny missing provider-runtime app boundary;
   - deny provider timeout/error;
   - `needs_grant` does not mutate provider-owned policy state;
   - audit redacts secrets and raw context keys.

7. Add explain UX. A denied operation should tell the operator whether a
   required provider-runtime boundary denied or the app-domain provider denied.

## Diagnose A Denial

1. Confirm the app is visible:

   ```bash
   ravi apps show <app-id> --json
   ```

2. Confirm the provider-runtime app boundary:

   ```bash
   ravi permissions explain use app:<app-id> \
     --agent <executor-agent-id> \
     --actor <actor-principal> \
     --chat <chat-principal> \
     --json

   ravi permissions explain execute app:<app-id> \
     --agent <executor-agent-id> \
     --actor <actor-principal> \
     --chat <chat-principal> \
     --json
   ```

   If the actor/agent lacks a provider-runtime decision equivalent to
   `use app:<id>` or `execute app:<id>`, fix the required boundary provider
   first. Do not debug app-domain provider policy yet.

3. Inspect the operation declaration:

   ```bash
   ravi apps show <app-id> --json
   ```

   Verify `operation.id`, `mutating`, declared permissions, and provider
   metadata.

4. Re-run the provider in dry-run/explain mode when available. Compare:

   - request actor/surface/session/executor;
   - resource owner;
   - operation action;
   - provider version;
   - provider reason code.

5. If the provider returned `needs_grant`, treat it as a denial. Apply the
   suggested grant only through the permission CLI/approval flow, with temporary
   lifetime by default.

## Diagnose Provider Drift

Symptoms:

- the same actor is allowed in one app path and denied in another;
- list/search shows resources that direct read denies;
- denial explain references stale policy;
- access persists after owner/team/resource change.

Checklist:

1. Check provider version in manifest and audit output.
2. Check whether a cached decision was used.
3. Invalidate provider caches after provider policy or resource changes.
4. Compare list/search request envelopes with direct read request envelopes.
5. Verify all paths use canonical actor/resource ids.
6. Verify no path parses prompt text, chat title, display name, or raw provider
   ids for authority.

## Roll Out Safely

1. Start in dry-run: record provider decision next to existing behavior, but do
   not enforce.
2. Compare decisions for real operations.
3. Fix false allows before false denies.
4. Enable enforcement for one low-risk operation.
5. Expand operation by operation.
6. Only then retire ad-hoc command-layer app permission checks.

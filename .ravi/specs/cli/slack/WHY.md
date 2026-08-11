# Slack CLI Agent Actions / WHY

## Rationale

Luis clarified that this workstream needs Slack management only, as agent
actions. The CLI should therefore model Slack resources directly, not Ravi's
internal routing and diagnostics surfaces.

## Decisions

### Use `channels` in the CLI

Slack's modern Web API often uses `conversations.*` for channels, private
channels, DMs, and MPIMs. The agent-facing CLI still exposes channel
management as `ravi slack channels-*` because the operational task is "manage
Slack channels".

The implementation can call `conversations.*` internally without leaking that
API vocabulary into the primary CLI UX.

### Keep Ravi Diagnostics Out

`ravi instances`, `ravi instances routes`, `ravi chats`, and
`ravi sessions trace` already own Ravi-side state. Putting those under
`ravi slack` would make the Slack CLI a mixed diagnostic facade instead of an
action surface.

The Slack CLI may print a next command that points to a Ravi diagnostic command
when useful, but it should not own that behavior.

### Write Brake With `--execute` And Exit 3 (Manual v2)

Agents can call tools autonomously. Slack writes are visible to real people and
some operations are destructive. Risky Slack mutations therefore default to a
dry-run and require `--execute` for the real write. Revoking Canvas access also
keeps that brake because it already existed before this migration: removing it
would turn the same legacy command from a preview into a live revocation.

The dry-run is not a silent success: it exits `3` with the
`WRITE_REQUIRES_EXECUTE` envelope so the calling agent explicitly sees "nothing
was written yet" and receives a safe summary of the material effect that
`--execute` would perform. The summary never serializes Slack IDs or payload
content. An earlier draft used `--dry-run`/`--apply` with exit 0; that was superseded by
the shared agent-first contract (`src/cli/agent-contract.ts`) so all 30+
migrated domains behave identically.

### Brake Before Credential Hydration Or Slack Web API Calls

The brake fires before ANY Slack Web API call, including reads.
`messages-replay` used to fetch the target message to enrich its dry-run; that
read was moved after the brake so a planning step costs zero Slack calls.
Enrichment belongs to `messages-inspect`, which is the read-only surface.

Side-effect-free local resolution (Ravi channel config, payload validation and
read-only artifact inspection) stays before the brake so a plan does not
promise an impossible write. Credential hydration does not: the broker can
initialize SQLite, read Keychain or Vault and append an audit event. Those
operations, plus Slack client construction, happen only after `--execute`.

The dry-run validates that the Ravi channel names a credential connection; it
does not claim that the credential record or secret was successfully loaded.
That validation is intentionally deferred to execution to preserve the
stronger zero-effect invariant.

### Suggestions Only From Local Sources

NOT_FOUND envelopes carry `suggestions`, but computing them must never trigger
extra Slack API calls. Channel-config suggestions come from the local config
store; artifact suggestions come from the local artifact ledger (SQLite).
Slack-side ids (message ts, canvas ids) get a `suggestedAction` pointing to the
read command that lists them instead.

### Admin Is Separate

Enterprise/admin Slack APIs have very different blast radius and token
requirements. They should not affect the MVP's scopes or ergonomics. If needed,
they belong under `ravi slack admin ...` with a separate permission model.

## Rejected Alternatives

- `ravi slack routes ...`: rejected because routes are Ravi-owned, not
  Slack-owned.
- `ravi slack chats ...`: rejected because canonical chats are Ravi storage,
  not Slack management.
- `ravi slack conversations ...` as the primary resource name: rejected for the
  first MVP because Luis explicitly asked for channel management and agent
  actions.
- `--dry-run`/`--apply` flag pair: rejected in favor of the shared `--execute`
  write brake so the Slack domain matches the contract of every other migrated
  CLI domain.
- Dry-run exit 0 with a `dryRun: true` payload: rejected because agents kept
  mistaking planned writes for performed writes; exit 3 makes the distinction
  structural.

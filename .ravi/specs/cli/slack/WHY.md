# Slack CLI Agent Actions / WHY

## Rationale

Luis clarified that this workstream needs Slack management only, as agent
actions. The CLI should therefore model Slack resources directly, not Ravi's
internal routing and diagnostics surfaces.

## Decisions

### Use `channels` in the CLI

Slack's modern Web API often uses `conversations.*` for channels, private
channels, DMs, and MPIMs. The agent-facing CLI should still expose channel
management as `ravi slack channels ...` because the operational task is "manage
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

### Dry-Run By Default

Agents can call tools autonomously. Slack writes are visible to real people and
some operations are destructive. Mutating Slack actions therefore default to
`--dry-run` and require `--apply`.

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

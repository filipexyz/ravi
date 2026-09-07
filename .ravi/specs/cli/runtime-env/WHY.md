# Runtime env agent-first CLI contract / WHY

Hub today writes `~/.ravi/.env` from the connector (`setRaviEnvironment`).
OSS only had the interactive `ravi setup` wizard and `ravi daemon env` (opens
an editor). Agents on a closed box cannot use a TTY, so the connector would
keep owning a private write path. This surface is the public, allowlisted,
gateway-ready replacement.

The allowlist is intentionally short. A generic `env set ANY_KEY` would turn
the Ravi env file into an unreviewed secret dump. Fail-closed unknown keys
force an explicit source change (with a comment) before a new key is writable.

`get` redacts secrets because Hub only needs presence, and returning the
token over the gateway would duplicate the secret in logs and SDK traces.
Non-secret allowlisted keys (`CODEX_HOME`, `GROK_HOME`,
`GROK_DISABLE_AUTOUPDATER`) stay visible so operators can confirm isolation
paths.

Writes are not braked. They are local, reversible via `unset`, and the
intended Hub happy path. Adding `--execute` would block closed-box
automation for no irreversibility.

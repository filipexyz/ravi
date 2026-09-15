# MCP Bridges agent-first CLI contract / WHY

An MCP bridge is a standing door into a Ravi project: external MCP clients
(Claude Desktop, Cursor) hold OAuth tokens minted for it. `revoke` slams that
door for every client at once — destructive, non-recoverable without
re-provisioning each client. That is the op that got the brake. The
pre-existing `--yes` confirmation stays as the documented equivalent of
`--execute` so nothing that scripts `--yes` today breaks, while agents get the
standard inspectable dry-run plan.

`create` stayed unbraked on purpose: it is additive (no existing resource is
modified), its reverse path is the braked `revoke`, and braking it would push
agents to reflexively append `--execute` to a command whose worst case is an
unused bridge. The real sensitivity of `create` is its OUTPUT — `bridgeToken`
is a bearer secret — and the contract handles that by scoping the token to the
success payload only, never to plans or envelopes.

Like `connectors` and `cloud-projects`, bridges live in Console, so there is
no cheap local corpus for not-found suggestions; remote errors keep the legacy
CloudAuthError funnel. The correction this migration makes is the rethrow
guard: a brake's `ContractError` used to be flattened into
`SERVER_UNAVAILABLE` exit 5 by the funnel, which broke the exit-3 semantics
exactly for agent callers.

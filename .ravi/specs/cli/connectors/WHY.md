# Connectors agent-first CLI contract / WHY

A connector is stored third-party authority: revoking one deletes the OAuth
tokens minted at the provider. That is the exact shape of mistake the write
brake exists for — one wrong id in an agent loop and Gmail/Calendar stop
working for every consumer of that connector. So `revoke` got the brake, and
the pre-existing `--yes` confirmation was kept as the documented equivalent
instead of being renamed: existing scripts that pass `--yes` keep working, and
the agent-facing contract gains the standard `--execute` polarity with an
inspectable plan.

`connect` deliberately did NOT get the brake. It opens a browser, sends the
human to the provider's consent page, and polls for up to five minutes. The
human consent screen IS the brake; an exit-3 dry-run in front of it would only
teach agents to always pass `--execute` on an op that cannot silently write
anything.

The other design decision is about not-found envelopes: connectors live in
Console/Link, not in a local table. Cheap local suggestions do not exist, and
fabricating them would mean an extra remote list call inside every error path.
The domain therefore keeps the legacy CloudAuthError funnel for remote errors
— with the one correction that matters: a `ContractError` from the brake is
rethrown before `cloudAuthErrorFromUnknown`, because the funnel used to
flatten it into `SERVER_UNAVAILABLE` exit 5 and silently destroy the exit-3
semantics for agent callers.

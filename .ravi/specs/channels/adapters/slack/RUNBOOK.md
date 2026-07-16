# Slack Adapter Runbook

## Local Smoke

1. Add a Slack connection through `ravi credentials`.
2. Register or update the Slack channel config in Ravi.
   - Set the explicit credential binding:
     `ravi channels set <slack-channel> credentialConnection <connection>`.
   - The provider is inferred from `provider=slack`; only the connection id is stored.
3. Start `ravi channels run` / `ravi channels start` when the native runner owns adapters, or restart the compatibility daemon while that path exists.
   Slack native uses Socket Mode by definition; there is no separate mode flag.
4. Send a DM or channel message to the Slack app.
5. Confirm the Ravi session responds in Slack.

## Debug

- No connection: check `ravi channels show <slack-channel>` and
  `ravi credentials connections show --provider slack --connection <id>`.
- No inbound: check Socket Mode logs and Slack app event subscriptions.
- Wrong thread: check `RAVI_SLACK_SUBSCRIPTION_SCOPE`, `RAVI_SLACK_THREAD_REPLY_MODE`, `RAVI_SLACK_ROOT_REPLY_MODE`.
- Duplicate response: check duplicate runner processes and Socket Mode lock.
- Known contact treated as unknown / false permission denial:
  1. Compare the `instance_id` the runtime addresses (account slug) against the
     `instanceId` stored on the workspace's platform identities (often the configured UUID)
     via `ravi instances list` and the `platform_identities` rows.
  2. Confirm the slug↔UUID mapping exists in configuration (`instances[slug].instanceId`
     and `instanceToAccount[uuid]`); alias resolution derives the canonical reference only
     from that mapping.
  3. Inspect the actor `identityProvenance` on the prompt source/participant: `reason`
     distinguishes `resolved`, `identity_not_found`, and `ambiguous_instance_alias`, and
     `canonicalInstance`/`matchedInstance` show which scope resolved.
  4. `ambiguous_instance_alias` means equivalent aliases point at different owners; this is
     intentional fail-closed behavior — reconcile the conflicting platform identities rather
     than expecting a match.
  5. The empty legacy scope is consulted only after scoped aliases miss and is never a
     wildcard; another workspace's rows are never selected.

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

## Foreign Bot Interop

Foreign bots follow the same route/channel and root/thread policy as human
messages after the local-identity, installation-visibility, and origin checks.
No mention or message-addressing alias setup is required. In an authorized test
channel, verify:

1. Plain text from a foreign bot with no mention or address reaches the expected
   session and uses the configured root reply mode.
2. A multiline message keeps its text and line breaks; a reply in an existing
   Slack thread follows the configured subscription/reply policy, using the
   thread session and replying in the same thread under the default policy.
3. `<@local_bot_user_id> status` is admitted under the same policy and carries
   the addressing marker; a mention of another user does not add that marker.
4. Ignored channels and missing routes still prevent a turn, with or without a
   local-bot mention. Replaying the same envelope produces at most one prompt.
5. A message emitted by the local bot itself is ignored, with or without a
   self-mention. Incomplete identity or invalid installation/origin proof still
   fails closed.
6. An unlinked or conflicting bot actor gains no authority from admission; a
   consistently linked bot agent retains its `agent:<actorAgentId>` principal.

## Debug

- No connection: check `ravi channels show <slack-channel>` and
  `ravi credentials connections show --provider slack --connection <id>`.
- No inbound: check Socket Mode logs and Slack app event subscriptions.
- Wrong thread: check `RAVI_SLACK_SUBSCRIPTION_SCOPE`, `RAVI_SLACK_THREAD_REPLY_MODE`, `RAVI_SLACK_ROOT_REPLY_MODE`.
- Duplicate response: check duplicate runner processes and Socket Mode lock.
- All bot messages ignored: inspect the `auth.test` warning. Ravi requires `ok=true`
  with a complete local `bot_id` + `user_id` + `team_id`. A matching
  `authorizations[].team_id` proves the installation even when `source_team`,
  `event.team`, or `payload.team_id` describes another Slack workspace. Since Slack
  can truncate the authorization list, a present-but-missing match fails closed; use
  `apps.event.authorizations.list` before adding support for that false-negative case.
  Only an actually absent `authorizations` key enables the strict legacy check:
  `payload.team_id` and `event.team` must identify one team equal to the local
  authenticated team. `source_team` must preserve origin when those values differ, and
  a missing origin always fails closed. Ravi never substitutes the logical channel
  account id. Inspect the separate
  `originTeamId`, `sourceTeamId`, `userTeamId`, `eventTeamId`, `payloadTeamId`,
  `authorizedTeamIds`, and `localTeamId` provenance fields to identify which check
  applied. `teamId` remains the legacy event-first effective value.
  Discovery is aborted after its five-second timeout, uses a bounded retry backoff,
  and retries on a later bot message instead of caching failure permanently.
- Foreign bot admitted but actor is unknown: inspect `identityProvenance.botIdentityReason`.
  `contact_identity_not_agent`, `conflicting_platform_owners`, `conflicting_agents`,
  and `ambiguous_instance_alias` are intentional fail-closed results. Link both Slack
  bot/user ids only when they represent the same agent; do not convert a bot identity
  into a contact to grant authority.
- Foreign bot without a mention is ignored: inspect the active runner version,
  local identity/installation/origin checks, then the selected route and normal
  channel policy. Bot authorship alone must not add an addressing requirement;
  adding an alias or mention is not required setup. Check root reply mode and
  thread/session provenance when the message appears in a different context.
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
  6. A previously resolved participant does not override a new alias conflict: the collision
     check runs before the participant cache, so a later slug/UUID owner conflict still
     fails closed. If a known actor suddenly reports `ambiguous_instance_alias`, look for a
     second platform identity that was linked under the other alias.
- Authority lost mid-conversation: a resolved Slack actor keeps the same owner and non-zero
  agent-identity/effective capabilities across turns and turn-context rotations. If a later
  turn drops to `missing_contact` or zero capabilities for an unchanged agent, inspect the
  turn's `identityProvenance` and confirm no conflicting alias identity was introduced
  between turns. A consistent bot identity should report `actorPrincipal=agent:<agentId>`;
  `missing_contact` for that actor indicates the actor principal was not propagated.

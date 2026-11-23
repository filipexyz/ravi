---
id: permissions/profiles/checks
title: "Permission Profile Checks"
kind: checks
domain: permissions
capability: profiles
---

# Permission Profile Checks

## Regression Tests

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/cli/commands/permissions.test.ts`
  covers all four built-ins before tag creation: dry-run without writes,
  allow/deny expansion parity with the executor materializers, apply of eligible
  profiles to a human in a Slack chat, read-back with `permissions list --chat`, empty grants,
  idempotent replay and revoke. A second contact stays at zero authority.
- Unknown profiles MUST name the available profiles and concrete inspection
  commands. A `full-access` preview MUST include the expanded ceiling and the
  explicit operator-approval requirement. `allow`/`resolve --profile full-access
  --apply` MUST fail with `FULL_ACCESS_APPROVAL_REQUIRED` before any profile,
  contact grant or agent-ceiling write while verified approval consumption is
  unavailable. The dry-run MUST NOT suggest that blocked apply command.
- `bun test src/permissions/grant-requests/` covers the core with fake adapters
  on two channels: a request is offered to every admin on every reachable channel
  and to nobody else (not the grantee, not an ordinary contact); it works from any
  turn channel and reuses an identical open request; no adapter, no eligible
  grantor or a failed delivery fails closed with nothing pending; an admin's
  answer applies the grant for the target chat only and writes no agent
  permission; asked on one channel and answered on another works; a non-admin, an
  unknown sender, the grantee and an admin who was not offered the request are
  ignored; the answer is the verified sender, never text; a request cannot be
  decided twice (the claim is single-use even when both read it as pending) or
  after it expired; the sweep expires it; and the core directory has no channel
  import or channel-name literal.
- `bun test src/channels/slack/grant-request-adapter.test.ts` covers the Slack
  adapter: it reaches only human Slack identities on enabled instances, sends a
  private card naming contact and chat with ids and offering one intent, turns an
  admin click into a core approval (card replaced), answers a non-admin click
  without granting, handles Ignore, later clicks and expiry, leaves legacy and
  foreign ids alone, and the legacy click feedback runner never answers a grant
  request.
- `bun test src/channels/whatsapp/grant-request-adapter.test.ts` covers the WhatsApp
  adapter: it reaches only contacts with a DM on an enabled WhatsApp instance (not
  groups, not a disabled instance, not someone who never wrote), at their most
  recent DM; the message names contact and chat with ids and the expiry; an
  approver's `aprovo`/`nego` applies or rejects through the core and is confirmed;
  only a whole word counts; a non-admin or unknown sender is ignored and told
  nothing, whatever the words claim; expired and already-decided answers are
  reported to the approver; a reply to any other message is left alone.
- `bun test src/omni/consumer-context.test.ts -t "quote-reply announcement"`: a
  quote-reply is announced with the raw sender jid, instance and account, also for
  a DM with no route or a sentinel DM, and a message that quotes nothing announces
  nothing.
- `bun test src/channels/grant-request-cross-channel.test.ts` covers both real
  adapters together: asked from a Slack turn and answered by an admin reachable only
  on WhatsApp, asked from a WhatsApp turn and answered by an admin reachable only on
  Slack, and a non-admin or a late answer refused on both.
- `bun test src/approval/grantor.test.ts` covers the channel-free gate: it asks the
  resolver registered for the channel and uses the generic lookup for the rest.
- `bun test src/cli/commands/permissions-request.test.ts` covers the command: it
  returns `pending` at once from a Slack, WhatsApp or terminal turn, only plans
  without `--execute`, fails closed with the three codes, accepts only full-access
  / one contact / one chat / an executor that already holds admin, reads the
  request back with `request-status` (`applied` only when the grant is in place)
  and the printed revoke command removes it.
- `bun test src/cli/remote-gateway.test.ts -t "full access approved"`: a remote
  `permissions allow|resolve` blocked with `FULL_ACCESS_APPROVAL_REQUIRED` names
  `permissions request full-access` and does not forward server text.
- More than 500 stored profiles, including older rows behind newer non-profile
  tags, MUST all appear in `acceptedValues`; the inline diagnostic stays bounded.

- Materialize an agent with `agent.defaults.runtimePermissions.profile =
  "full-access"` and assert `admin system:*`, `execute executable:*`,
  `use tool:*`, and `use skill:*` appear with `agent-default-capabilities`
  provenance.
- Persist `chat-only` as `{ profile: "chat-only" }` (never `null`). Materialize
  of that agent and its `agent_identity` MUST have no `use:tool:*` and no
  bootstrap execute groups/executables. `permissions <id> none` MUST still
  restore the bootstrap floor.
- CLI/help for `agents permissions` MUST list `chat-only` beside
  bootstrap/full-access and MUST describe `none`/`clear`/`off` as reset to
  bootstrap minimum, not zero-authority.
- Materialize an agent with explicit runtime capabilities and assert only those
  capabilities are added beyond bootstrap.
- Materialize a contact tagged `permission.admin` and assert admin authority
  appears only through `contact-policy-permissions`.
- `permissions allow <profile> --to contact:<id>` without `--chat`,
  `--chat-tag`, or `--force` MUST fail with `CHAT_SCOPE_REQUIRED`; with
  `--chat` it MUST store a chat-scoped grant and MUST NOT attach a global
  contact tag.
- Add a generic CRM tag and assert it does not materialize runtime authority.
- Build delegated authority with agent, actor, surface, and turn capabilities;
  assert intersection, surface inheritance, explicit deny, constraints, and
  overrides match `src/permissions/delegation.test.ts`.
- Create an agent under a runtime creator and assert creator visibility is
  persisted as `view agent:<created-id>` in provider-owned config.
- Initialize the DB with existing agents and assert the default agent
  materializes `view agent:*`.
- CLI/help output for `agents create`, `agents permissions`, command-access
  denials, and permission approval prompts MUST present profile/tag or
  least-privilege inspection as the normal next step and label `full-access` as
  break-glass.
- `permissions check --json` for a denied capability MUST include the shared
  guidance envelope with `canonicalCapability`, `inspectCommands`,
  `preferredPath`, `rawCapabilityFallback`, `breakGlass`, `requestShape`, and
  `nextSteps`.
- When a provider-owned system tag from source `permissions` contains the
  missing capability, `permissions check` and command-access denial guidance
  MUST name that tag in `preferredPath.suggestedTags`.
- Permission approval prompts MUST say the approval is for the current context
  only and point recurring access to provider-owned profile/tag policy.
- The installed `ravi-system-permissions-manager` skill MUST teach agents to
  materialize/check first, ask for provider-owned profiles/tags for recurring
  access, and avoid `full-access` except break-glass.

## Commands

```bash
bun test src/permissions/provider-runtime.test.ts
bun test src/permissions/chat-only-parity.test.ts
bun test src/permissions/delegation.test.ts
bun test src/cli/commands/agents.test.ts
bun test src/cli/commands/permissions.test.ts src/cli/command-access.test.ts src/approval/service.test.ts
```

## Shared definition reductions

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/router/router-db.contexts.test.ts`
  MUST preserve context provenance, capabilities and lifecycle timestamps when
  recording authority withdrawal. Metadata and descendant revocations MUST
  commit or roll back together inside the caller's transaction; unrelated
  contexts and existing lineage MUST remain intact.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/cli/commands/permissions.test.ts`
  MUST cover a legacy chat-only definition shared by multiple contacts and chat,
  chat-tag and global grants: dry-run leaves snapshots live, apply revokes all
  affected roots, descendants and actor projections, and another profile stays
  live. A rejected context write MUST roll back the profile and all revocations.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/permissions/apply-grant.test.ts src/runtime/context-registry.test.ts`
  MUST retain direct profile-source snapshot revocation and prove label-only and
  additive updates leave existing contexts live.
  Regressions MUST cover live issued children behind revoked roots/projections
  and unrelated colon-bearing profile names that share the target's suffix.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/runtime/runtime-request-context.test.ts`
  MUST revoke issued and chained relays after a shared profile reduction and
  prevent queued relays from historical callers restoring the old authority.
  Ordinary turn rotation MUST still allow queued relays to preserve their
  original narrowing, and contact attribution MUST survive authority withdrawal.

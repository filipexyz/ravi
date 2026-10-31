---
id: runtime/human-bridge
title: "Private human conversations from Fleet"
kind: capability
domain: runtime
capability: human-bridge
status: active
normative: true
applies_to:
  - src/bridge/**
  - src/cli/commands/bridge.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/codex-provider.ts
owners:
  - ravi-dev
---

# Private human conversations

- The bridge listener is disabled unless `RAVI_HUMAN_BRIDGE=1`. Non-bridge
  authorization/events must not create bridge state. The bridge namespace is
  exactly `agent:<agent>:console:<uuid>`, not an arbitrary substring. Existing
  Codex hook flags, auth, API routes and permission decisions remain unchanged
  for ordinary turns. A bridge turn never bypasses revoked/expired runtime
  context validation; local chat-only profiles do not override its Console grant.

- SSH authenticates a dedicated transport account, never a human. Its only
  command is `ravi bridge serve-stdio`; it forwards bytes to the dedicated
  bridge socket and has no access to Ravi's state, general CLI gateway or model
  credentials. No PTY, forwarding, password or arbitrary command is allowed.
- The runtime verifies an Ed25519 delegation for EVERY request against a local
  enrollment. The issuer, runtime audience, organization, installation, subject,
  project, agent list, epoch, connection nonce and canonical request digest are
  mandatory. Lifetime is at most30seconds. Each assertion JTI is consumed once.
- Enrollment is operator reviewed. Pins are exchanged through the authorized
  management path, never taken from a browser/SSH peer. Runtime proof signs the
  fresh connection nonce; Fleet checks it before issuing the delegation. The
  CLI accepts one active organization per runtime; replacement increases epoch.
- Conversations are NEW private `agent:<agent>:console:<uuid>` sessions. Existing
  channel sessions cannot be adopted. Every read, receipt and cursor is bound
  to the owner, enrollment, project and authorized agent. Name/email is not an ID.
- Console is the sole permission authority for bridge-managed turns. Enrollment
  contains only issuer/org/installation/runtime pins, epoch and active transport
  trust. It contains NO subjects, project/agent allowlists, capabilities or local
  permission profiles. Agent configuration selects execution/provider settings,
  never a second permission ceiling. Non-bridge paths retain their own authority.
- Protocol v2 delegates per-agent concrete capabilities and conditional actions,
  bound to the Console's policy revision/digest. Console policy administration
  uses its existing draft/preview/publish and CAS flow. Human membership and
  read/send/approve grants are rechecked before signing every request.
- Runtime validates the signed decision and its scope; it does not consult local
  agent/identity profiles, provider policy chains, executable allowlists or skill
  permission gates for bridge execution. Child contexts retain identity and can
  only attenuate the delegated capabilities. They cannot become root turns or
  inject a bridge binding from an unrelated context. Foreign sessions deny.
- The command adapter supports a single literal executable and argv (no shell
  expansion/programs/redirection/environment assignment). This is an execution
  protocol constraint, not a permission allowlist; every executable still needs
  a Console decision. Unsupported native tools fail closed. The read-only native
  sandbox and resource isolation are mandatory; grants cannot disable them.
- The Codex bridge uses a private provider profile, read-only native sandbox and
  a synchronous guard covering all native tools. Unsupported tools deny. Before
  starting a thread, the app-server must list exactly the generated guard;
  trust is recorded for that exact definition hash and read back. Missing,
  disabled, modified, foreign or untrusted guards prevent dispatch. CLI failure
  or malformed hook output is a denial. No trust/sandbox bypass is permitted.
- Model credentials stay in the installation. A local operator must explicitly
  configure `RAVI_BRIDGE_CODEX_AUTH_FILE` (absolute regular0600 JSON), a native
  model-broker binding, or `RAVI_BRIDGE_CODEX_PROVIDER_FILE` (private JSON with
  provider id, HTTPS baseUrl and absolute private apiKeyFile). Custom Responses
  providers use the same Codex sandbox/guard. The key is loaded only into the
  provider process as BRIDGE_MODEL_API_KEY, outside the shell environment allowlist;
  generated TOML contains only its env-key name. Existing conversation provider
  configuration must match; mismatches require a new conversation. Neither
  credential nor rctx is returned to Fleet/browser or written to evidence.
- Mutations use immutable UUID request IDs plus createdAt and canonical digest.
  A SQLite transaction persists receipt, accepted message and durable dispatch
  row before acknowledgment. Retries return the same receipt and cannot repeat
  dispatch; altered payload conflicts. First admission expires after10minutes.
  Receipts and human event journal remain durable for the pilot; no automatic
  deletion is implemented. Storage/retention operations must preserve receipts.
- A daemon restart terminalizes uncertain running work without replaying it.
  New turns use compare-and-swap conversation version and one active turn per
  conversation (at most3 per human). New dispatch has a30second lease, refreshed
  only by a newly authorized request. A fresh Console policy revision replaces
  the current decision, including grants; old revisions and equal revisions with
  different digests are rejected using durable per-subject/project high-water
  marks. New decisions received on reads narrow/replace running-turn authority
  without extending leases. Loss of send access expires the turn. If Console
  stops issuing delegation, authority expires within30seconds plus a250ms abort
  tick. In-flight effects cannot be undone; revocation is bounded, not instantaneous.
- Cancellation commits before interrupting the native runtime. It revokes new
  action authority immediately; final cancellation is reported from the native
  interrupt event carrying the exact bridge turn ID. It does not undo effects.
- Approval is owner-only, eligible under the current Console decision,
  bound to the live turn, exact action digest, version and expiry. It authorizes
  one waiting invocation, never grants future invocations. Revoking conditional
  eligibility invalidates a pending action without local policy edits. Terminal turns
  invalidate pending decisions and journal those transitions.
- The human journal contains accepted/final messages and bounded state events;
  a native response bound to the current bridge turn is preserved in full even
  when it begins with text from an earlier turn. History-prefix heuristics MUST
  NOT truncate that response. Same-turn duplicate delivery remains suppressed.
  raw reasoning, provider prompts, raw tool payloads and debug SSE are excluded.
  Fleet polls the signed transport and exposes SSE with durable scoped cursors.
  Read/reconnect does not renew execution authority. Browser storage contains
  no secrets; an uncertain send keeps its original request identity for retry.

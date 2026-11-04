---
id: credentials/slack-intake
title: Private Slack credential intake
kind: capability
domain: credentials
capabilities:
  - slack-intake
tags:
  - security
  - slack
applies_to:
  - src/credentials/intake.ts
  - src/channels/slack/credential-intake.ts
  - src/cli/commands/credential-intake.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Private Slack credential intake

## Contract

`ravi credentials request <target>` accepts metadata only. The caller MUST hold
`mutate:credentials.requests:<target>`. The human receiving, opening and submitting
the modal MUST resolve to a canonical contact in the receiving Slack instance and
hold `mutate:credentials.secrets:<target>`. Request authority MUST NOT imply write,
read, broker execution, use, or permission-grant authority. Existing `@CliOnly`
credential operations MUST remain CLI-only. No new grants are installed.

Targets are `env:<key>` and `connection:<provider>:<connection>`. Env keys MUST be
in the existing allowlist and its secret-key subset; the OAuth token destination
is excluded from this direct API-token intake. Non-secret process configuration,
unknown keys and arbitrary paths MUST fail closed. A connection MUST reuse the
existing identifier/backend validation and the provider's existing secret parser
where present (Slack's token bundle). Existing targets MUST NOT be overwritten.

Scope MUST be truthful: env is host-wide; a connection belongs to its provider
and existing use permissions. This intake MUST NOT imply agent/session isolation
or silently edit agent allowlists. Runtime/model credential-pool registration,
rotation and new permission grants are separate operations.

## Sensitive boundary

- Direct Socket Mode is the only supported ingress. Requests on cloud gateway
  transports MUST fail before sending the secret form, because this repo cannot
  establish the upstream persistence contract.
- The invitation MUST be ephemeral, bound to account, workspace, human and
  conversation. A click supplies Slack's short-lived trigger; no model turn is
  used to open the modal.
- Request metadata lives server-side with a random identifier, a ten-minute
  expiry, a bound view and an atomic one-use claim. The modal MUST NOT be trusted
  to supply a target, actor, backend or scope. The issuing turn hands off to the
  bounded request; current agent authority and human authority are checked again.
- Reserved intake interactions, including malformed, denied, expired, cancelled
  and replayed callbacks, MUST be intercepted before inbox acceptance, generic
  ACK, interaction normalization, NATS, triggers or response-URL persistence.
- The raw payload MUST be erased before async processing. Secret values and
  `response_url` MUST NOT reach messages, logs, traces, artifacts, permission
  audit, general event storage or generic CLI arguments.
- The only durable secret sinks are the approved backend or the existing atomic
  mode-0600 allowlisted env writer. Parser/backend/API errors MUST be replaced
  with fixed error codes without a raw cause.
- Audit MUST include actor, request, issuer, target, scope, result and fingerprint,
  never input values or raw exceptions. Fingerprints identify high-entropy API
  tokens; password hashing is not a supported use of this flow.
- Submission replaces the input view with a processing view and then a receipt
  containing a fingerprint. Confirmation MUST stay in the modal; no public
  message or history is created. Failed display delivery MUST NOT reverse or
  misrepresent a successful write.
- Env writes MUST report that process configuration reload is needed. They MUST
  NOT automatically restart the daemon or claim the new key is already active.

## Supported credential class

The default is a revocable API token through Slack's infrastructure. Slack's
plain-text input has no password mode and shows the value while editing; the UI
MUST state this. Passwords and long-lived OAuth refresh/session credentials
SHOULD use provider-native authorization or a separately authenticated, private,
one-use web intake. This change does not ship or pretend to ship that web path.

## Storage

Provider connections default to a local file backend on Linux and macOS. The
private directory MUST be mode 0700 and secret files mode 0600, with atomic
writes and strict broker-owned references. This is plaintext protected by the
host account, not encryption at rest. It MUST NOT require a desktop session,
Vault, a new daemon or custom key management. Keychain and Vault remain optional.
Existing credentials MUST retain their backend; deployment does not move secrets.

## Optional Keychain boundary

Keychain writes MUST carry secret bytes only on stdin, never argv/environment.
The native command parser's bounded input limit MUST fail closed. Backend output
MUST be discarded and errors typed, with a finite process timeout. Larger token
bundles use the default file backend or Vault. No tests write the operator's real Keychain.

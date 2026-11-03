# Fleet configuration

One installation MUST configure exactly one organization. Configuration, secret
custody, permission to use and observed health are separate contracts.

Browser operations MUST use an authenticated, active membership of the configured
organization, current explicit action/resource authorization from the Console's
single policy engine, exact-origin CSRF checks and bounded typed inputs.
Anonymous development auth MUST NOT administer secrets. Consumers MUST recheck
credential state/version before use. Metadata APIs MUST NOT return secret values,
Vault paths, backend error bodies or remote command output. Audit MUST record actor,
target, request and safe result; never request bodies or secret fingerprints.

Names of roles, including owner/admin, MUST NOT grant authority. Organization read
and manage actions are separate; manage does not imply read. Policy decisions MUST
be checked in the existing effect transaction and a refusal audit must commit
without the effect. UI capabilities are observations, not reusable permissions.
Authentication/group admission MUST NOT imply project membership or unrestricted
linked-agent grants. Initial protected bootstrap grants only organization actions
atomically with identity and consumed setup claim; existing members are never
silently migrated from a legacy role. Joint tests are required.

An OIDC client secret MUST be bound at creation to its exact issuer and client ID.
That binding MUST remain immutable across rotation; a different destination
requires a new credential. Permission to use MUST NOT become permission to send
a stored bearer secret to an arbitrary endpoint.

Vault KV v2 is the initial secret provider. Console MUST authenticate through a
protected token file (compatible with a Vault Agent sink), not a permanent root
token. TLS verification MUST remain enabled. Vault bootstrap/unseal custody is
an operator boundary, not something the UI may silently invent or bypass.

Edits MUST use optimistic concurrency. Retries MUST keep the same operation key
and payload. Save is not validation; validation is not activation. Rotation MUST
invalidate dependent validation. Revocation MUST prevent future credential use;
it MUST NOT masquerade as upstream provider revocation or erase audit/history.

SSH MUST pin the independently confirmed host-key fingerprint before authenticating,
resolve and validate target addresses before connecting, and expose no arbitrary
command, agent forwarding or root/shared personal credentials. A transport/CLI
probe MUST NOT claim user delegation or conversational bridge availability.
The SSH port MUST belong to an explicit installation-level allowlist (default22);
being private is not permission to probe arbitrary ports.

External I/O MUST occur outside organization database locks. A short authorized
reservation and a short finalization MUST recheck current identity, policy,
deadline and exact configuration/credential revisions. Slow I/O MUST NOT serialize
unrelated navigation/login. Unknown completion MUST fail closed, not auto-repeat
an external effect. Versioned operation HMACs MUST use HKDF domain separation;
existing exact legacy receipts remain read-only retry evidence, not new authority.

Successful read decisions MAY omit repetitive decision-audit rows; denials and
effects MUST remain traceable. Compiled policy caches MUST be bounded and keyed
by validated content; identity, delegation, current head and decisions MUST NOT
be cached across requests. Retention or physical destruction requires operator
policy; suspension is not user deletion, and authorship is not secret ownership.

SSO activation MUST follow a real candidate login and a verified administrator
identity, bound to the exact config/secret versions. Existing login stays usable
until activation. No first-visitor owner, JIT owner or email-only identity takeover.
Recovery credentials require one-time, time-bounded, protected operator issuance.

The Console AI engine MUST stay off. Agents belong to Ravi installations. Mail,
commercial central and migration of live Slack/channel connectors remain out of scope.

## Authorized Console gateway

Private conversations use the canonical Ravi command/schema/dispatcher over
restricted SSH HTTP/SSE. Console decisions are signed for at most30s, bound to
subject/install/project/action/resource, current policy and exact request bytes.
Revalidate after transport and signer I/O; denials/effect decisions share the
operation ID in audit. Control permission does not add turn capabilities.
Console stores delivery identity/status/digest; Ravi retains private history and
execution recovery. Browser/channel/automation origins are explicit; only the
OIDC browser adapter is activated by this implementation. No live channel moves.

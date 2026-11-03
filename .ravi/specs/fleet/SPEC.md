# Console and installation management

The Console/API and privileged runtime share this MIT source distribution, not
their identities or execution privileges. A runtime MUST NOT receive a Console
administrative credential, database credential or CA signing key. Full machine
access requires a different host or properly limited VM from the control plane.
Containers sharing a host kernel do not establish that stronger isolation claim.

Human operations use the Console's existing OIDC session and current organization
policy transaction. Installation mTLS is valid only for its own management queue,
receipts and credential rotation. Proxy headers cannot assert this identity.
The runtime initiates all management connections. Native Node HTTPS terminates
mTLS on the server and client; the Bun runtime invokes a bounded Node helper with
credentials on stdin, never argv or a browser SDK.

Association requires explicit browser consent to the installation key. A link
transports the proof in its fragment. Knowing a LAN address or discovery result
grants no authority. A successful association is distinct from a verified command.
Node certificates are scoped, expiring, rotating and revocable. Retrying rotation
recovers only the exact same CSR/operation while the installation remains active.

Management contracts are neutral Zod descriptors projected through the single
SDK generator. Browser clients import no privileged handlers or runtime keys.
Human authorization is checked before enqueue and delivery. A journal admits an
operation durably before executing it. Its digest, installation and deadline are
checked. A crashed/incomplete effect is uncertain and MUST NOT be repeated.
Unacknowledged receipts survive restart and reconcile independently of permission
to execute new commands. Replaying a receipt cannot authorize another effect.

Native channel adapters remain on Ravi installations. Console configuration uses
those adapters and the native credential broker. Only public account identity
and credential references cross this management contract. Managed bot identity
has one connection owner; unresolved configuration cannot transfer ownership or
create another listener. A configuration receipt is not a claim of Slack delivery.
Cross-installation event routing is not implemented by this management surface.

Onboarding ends at verified installation and explicit completion, followed by
management. People and channels are optional. No Console chat or invented Desktop
entry point belongs to this flow. Existing standalone Desktop serving routes may
remain for separately supplied artifacts, without adding chat to onboarding.

Fresh installation MUST refuse overwriting an existing installation directory.
Its secrets are private files, its images immutable, and migrations explicit.
Testing/reset of an existing deployment requires exact target inventory and a
recoverable snapshot. Reset never implies production or other stack resources.

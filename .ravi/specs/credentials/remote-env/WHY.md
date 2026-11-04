# Why a receiver operation instead of copying an env file

Copying a local `.env` replaces remote state whose variables may have different
owners, activation rules and concurrent writers. Even copying a one-key fragment
and then merging it through an agent shell exposes the value and moves parsing,
quoting and authority into unrestricted command execution.

The narrow primitive is an add-only request for one known destination/key. A
trusted receiver owns its env syntax, policy, lock, commit and receipt; the agent
owns only the request and its non-secret status. No separate daemon, Vault,
desktop keychain, custom cryptography or arbitrary SSH command is required.

Static SSH alias discovery helps the operator identify a server without executing
their config. It deliberately does not inherit personal admin users, keys,
proxies or unsafe host-verification settings. A destination is explicit and
immutable so the target approved in a modal cannot drift between confirmation
and commit.

The supported dotenv profile is intentionally narrow. Refusing ambiguous,
multiline or expansion-dependent input is safer than silently rewriting another
consumer's syntax. Rotation and unsupported parser profiles can be added only
with their own explicit compare-and-swap and roundtrip guarantees.

The receiver and agent must run under separate authority. If the agent can run
as the secret owner, alter the application that reads it, or use an unrestricted
administrator SSH key, hiding a CLI value does not make the credential
unreadable. The deployment instructions state that limitation instead of
claiming that file permissions alone solve it.

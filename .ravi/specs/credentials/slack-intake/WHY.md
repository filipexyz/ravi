# Why this route

Direct Block Kit wins for revocable API tokens: one private button, one modal,
no terminal, no extra browser identity/session. It still makes Slack a processor
of the secret. A modal is absent from channel history, not absent from Slack's
infrastructure. The input is plain text, not a password field.

A private one-use link wins for passwords and long-lived OAuth credentials when
it terminates directly at a trusted secret boundary. It needs authenticated actor
binding, expiry, atomic one-use semantics, CSRF protection, cache/referrer/log
controls and a secret-safe transport to the host. Publishing a normal Ravi Page
or calling a generic command with the secret would not provide those guarantees.
Prefer native OAuth instead of collecting a refresh token manually.

This version implements the direct route only for direct Socket Mode. Gateway
mode is rejected before the form: local redaction cannot undo upstream queueing.
No broad CLI-only exception or command runner is introduced. The CLI command is
a metadata request; a separate authenticated human interaction owns the write.

Add-only behavior and fixed read-only destination metadata prevent an agent or
modified modal from converting a request into credential rotation, a permission
grant, an arbitrary env write or a different scope. The current env store is
host-wide. Agent/session scoping cannot be honestly invented by changing labels.

Linux is a primary installation target. The operator explicitly requested a
simple solution with no Vault requirement, so provider connections default to
private local files, using the same host-account trust boundary as the existing
env file. Custom encryption and installation key management were rejected.
Keychain and Vault are explicit options, not prerequisites. An operator or process
that can read the account's private files can read the credentials; this is not
presented as protection from a compromised host.

References: [Slack modal lifecycle](https://docs.slack.dev/surfaces/modals/),
[plain-text input contract](https://docs.slack.dev/reference/block-kit/block-elements/plain-text-input-element/),
[Apple SecurityTool parser](https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c).

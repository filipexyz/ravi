# Cloud Auth / WHY

## Why Keep This Spec Small In OSS

The open-source CLI needs to know how to authenticate safely and call a stable
Console API. It does not need the private business rules for Ravi Cloud,
`ravi.page`, billing, quotas, hosted runtime, or private asset authorization.

Keeping this spec to the client contract lets the local Ravi CLI remain useful
for any compatible Console endpoint without leaking proprietary platform
strategy into the public repo.

## Why Not Browser Cookies

Browser cookies are scoped to the web session and are awkward to revoke per
machine. CLI credentials need different lifetime, storage, refresh, and audit
semantics.

The CLI should prove the human through the browser, then operate with CLI
credentials issued for that local installation.

The complete authorize URL must carry `user_code`. Console's bare
`/cli/authorize` page does not attach the pending device grant, so a human or
agent who opens that page can approve a session the CLI will never receive.
Printing the code on a separate line is not enough: operators and agents copy
the first URL they see. If Console omits `verification_uri_complete`, the CLI
must add `user_code` itself rather than falling back to the bare URI.

## Why A Multi-User Store

A shared host can have more than one Console user. Overwriting
`credentials.json` makes `ravi whoami` lie and lets one login clobber another.
Keying slots by `consoleUserId` plus an `activeUserId` pointer keeps
`ravi whoami` working for the current user without losing the others.

Linux is the default host. Keychain-only storage would lock the product to
macOS. The portable `0600` file is the default; libsecret and Keychain are
optional backends with capability detection.

## Why Console Session Tokens Are Not Provider Tokens

`ravi login` stores Ravi-owned Console JWTs so the CLI can call Console and
Link. Gmail/Slack/provider OAuth tokens stay on `link.ravi.so`. Mixing those
classes would put third-party plaintext on disk and break the Worker vault
boundary.

## Why Keep Local Artifacts Offline-Capable

Artifacts are a Ravi primitive. Cloud publishing is an extension of that
primitive, not a replacement. A user should be able to create, inspect, version,
and restore local artifacts without a Console account.


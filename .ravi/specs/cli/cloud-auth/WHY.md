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

## Why Keep Local Artifacts Offline-Capable

Artifacts are a Ravi primitive. Cloud publishing is an extension of that
primitive, not a replacement. A user should be able to create, inspect, version,
and restore local artifacts without a Console account.


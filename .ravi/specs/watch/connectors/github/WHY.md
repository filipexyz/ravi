# GitHub Watch Connector / WHY

## Why GitHub App Webhooks Are The Default

GitHub's own REST guidance says integrations should prefer webhooks over
polling. Webhooks are also the only practical way to support private repos,
organization installations, always-on delivery, and low-latency updates without
keeping personal tokens on the user's machine.

The GitHub App model also gives Console a clean installation boundary:
repository selection, per-permission access, installation ids in webhook
payloads, and installation access tokens when follow-up API reads are needed.

In user-facing shorthand this is the "Ravi bot on GitHub". In implementation it
is a GitHub App owned by Console, not a local bot process in OSS.

## Why Not One Repository Webhook Per Watch

One repo can have many Ravi watches and many group triggers. Creating a provider
webhook for every watch would multiply GitHub configuration, secrets,
deliveries, retries, and admin requirements.

The efficient shape is one app-level webhook stream per installation, then
internal fanout/filtering by repo, event family, action, branch, label, workflow,
and watch id.

## Why Local Polling Still Exists

Local polling is useful for quick public repo watches, explicit local debug, and
simple environments without Console setup. It is not the complete path.

GitHub's repository events API is documented as not real-time, so local polling
must use event-family endpoints and conditional requests when the user asks for
fine-grained events.

## Why Event Types Are Derived

GitHub often sends broad webhook event names plus an `action` field or state in
the payload. Ravi triggers need stable, narrow subjects. Deriving
`pull_request.merged`, `workflow_run.failed`, or `star.created` keeps group
triggers simple and avoids forcing prompt authors to understand raw GitHub
payloads.

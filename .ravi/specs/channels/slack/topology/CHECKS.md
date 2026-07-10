# Slack Topology Checks

- `ravi slack topology --channel <slack-channel> --json` returns `channels`.
- Topology output does not expose `sections`, `sectionIds`, `customSidebarSections` or Slack `usergroups.*` as grouping data.
- Route metadata is read-only and does not create new sessions.
- A route with `session` reports `routeSession` separately from Slack channel identity.
- Every channel reports `ravi.policyGate`.
- A channel matched only by default/account routing under `groupPolicy=allowlist` reports `policyGate.inboundAllowed=false`.
- A channel with an explicit `group:<channelId>` route under `groupPolicy=allowlist` reports `policyGate.inboundAllowed=true` and `policyGate.reason="explicit_route"`.

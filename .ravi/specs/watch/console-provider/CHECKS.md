# Console Provider Watches / CHECKS

## API Contract Checks

- Capabilities response is enough for `--placement auto`.
- Create response returns watch id, status, event types, and trigger subjects.
- Capabilities response includes per-event placement, required capabilities,
  provider permissions, fidelity, and webhook-only flags.
- Missing install/repo/permission errors include actionable safe metadata.
- Delete removes the Console watch mapping but not the provider app
  installation.

## Security Checks

- GitHub webhook signature is verified before payload parse/trust.
- Provider installation and repository selection are validated before watch
  matching.
- Raw webhook body, tokens, secrets, raw headers, diffs, and patch bodies are
  not persisted in delivery payloads or logs.
- Drops caused by permission or repo mismatch are auditable with safe metadata.

## Delivery Checks

- Console creates a delivery item for matched watch events.
- Delivery item `eventType` uses `watch.<provider>.<event>`.
- Local bridge republishes `ravi.watch.<provider>.<event>`.
- Dedupe preserves provider delivery identity and prevents duplicate trigger
  fires on webhook retry.
- A single webhook matching two watches creates two watch-level delivery items,
  not one collapsed item.

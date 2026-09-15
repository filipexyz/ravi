# Channel Chat Actions Runbook

1. Run `ravi sessions actions --json`.
2. Confirm the selected surface and per-surface availability.
3. Check the stable unavailable reason before changing configuration.
4. For a queued action, trace its request id and idempotency key through the
   channel runner.
5. For provider rejection, preserve the provider error code without exposing
   credentials.
6. Confirm edit/delete local state changed only after provider success.

Common diagnoses:

- `missing_connection`: configure the channel credential binding.
- `missing_scope`: update provider scopes and refresh the credential.
- `unverifiable_ownership`: target a message with durable session provenance.
- `adapter_unavailable`: inspect channel runner health.

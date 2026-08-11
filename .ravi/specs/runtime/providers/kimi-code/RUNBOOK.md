# Kimi Code Provider Runbook

This runbook describes expected operation after implementation. Commands and exact
credential integration must be revalidated against the implementation branch.

## Preconditions

- A Kimi membership that includes Kimi Code API access.
- A Kimi Code API key created in the official Kimi Console.
- A model available to that membership tier.
- A RAVI build containing the `kimi-code` provider.

Do not use a Moonshot Open Platform key with the Kimi Code membership endpoint.

## Secure setup

1. Create a newly issued dedicated Kimi Code API key for RAVI. Never reuse a key
   exposed in chat, a ticket, a fixture, or another public artifact.
2. Store it only through the RAVI-owned credential/environment mechanism.
3. Do not add the value to a repository, agent prompt, task, trace, screenshot, or
   shell history.
4. Verify provider discovery and model catalog before a live prompt.
5. Start with `k3-256k` because Kimi's model documentation states lower relative
   consumption within 256K. This is a model-selection recommendation, not an
   estimate of remaining membership quota. Choose `k3` when the larger context or
   video input becomes relevant in a future multimodal version.

Expected conceptual configuration:

```text
provider: kimi-code
model: k3-256k
effort: high
credential: supplied by RAVI credential environment
```

## Preflight

Verify:

- provider id resolves to `kimi-code`;
- selected model is one of the documented membership IDs;
- no live request contains an arbitrary base URL;
- capability output reports media, fork, parallel tools, plugins, MCP, and remote
  spawn as unsupported in v1;
- credential errors are reported as Kimi Code membership errors, not Moonshot
  Platform errors.

## Minimal live smoke

Run live smoke tests only after all offline checks pass.

1. Send a short text prompt with no tools.
2. Verify streamed text and exactly one terminal event.
3. Send a synthetic prompt that calls one harmless host tool.
4. Verify one authorization, one execution, one tool result, and one final answer.
5. Continue the same session and verify that prior public context is understood.
6. Interrupt a long synthetic turn and verify `turn.interrupted` with no partial
   assistant message committed.
7. Inspect redacted traces for provider, model, effort, usage, and terminal state.

Never publish a wire capture containing authorization, personal prompts, local
paths, provider reasoning, or account metadata.

## Common failures

### Authentication failure

Check that the key was created in the Kimi Code Console and is being sent to the
Kimi Code endpoint family. Do not retry repeatedly. Do not cross-test the key on
Moonshot Open Platform.

### Entitlement or model failure

Confirm membership tier and selected model. The adapter must not replace the model
silently. Select an entitled model explicitly or fix the membership state.

### Rate or quota limit

Read structured reset/retry metadata. Kimi Code quota is shared across the account,
devices, clients, and API keys. Creating another key does not create another quota.
Do not retry until the declared window permits it.

### Context limit

Start a new session or compact through a future generic RAVI continuity mechanism.
Do not switch models inside an oversized state unless the adapter has validated the
new model context and cache behavior.

### Tool loop stalls

Inspect canonical tool start/completion pairs and terminal tracker output. A tool
result without a subsequent terminal event must be converted into a bounded failure
by the host inactivity policy.

### Duplicate response after restart

Stop automatic replay. The stateless Kimi API cannot prove ambiguous delivery by
itself. Preserve the pending turn and require generic RAVI replay authority rather
than guessing.

## Rollback

Rollback is configuration-first. Before starting any new sessions, remove
`RAVI_KIMI_CODE_ENABLED` or set it to any value other than `1`. This prevents only
new `kimi-code` sessions; it does not remove registration/model discovery or delete,
translate, or migrate existing Kimi provider state.

1. Disable the flag for the affected agent processes before they start new sessions.
2. Select an existing provider explicitly for affected agents.
3. Preserve Kimi provider state for diagnosis; do not translate it into another
   provider automatically.
4. Remove the provider registry entry and provider-local files only if code rollback
   is required.

No existing provider or model selector should require migration.

## Dedicated credential rotation

This procedure operationalizes the [SPEC's credential and quota rules](SPEC.md#service-and-credentials)
and [usage and quota rules](SPEC.md#usage-and-quota); the SPEC remains normative.

1. Decide rotation is required for expiry, scheduled replacement, or suspected
   exposure. Quota, rate limits, and membership windows never authorize rotation or
   a second key to bypass the limit.
2. Obtain a newly issued replacement key through the provider console and transfer
   it only through the approved private channel. An exposed key is never reused.
3. Update the RAVI secret store or managed credential record without placing either
   key in git, shell history, application logs, traces, prompts, screenshots, or
   public reports. Verify only non-secret credential metadata.
4. Set `RAVI_KIMI_CODE_ENABLED=1` only for the one dev-agent canary before it starts
   a new session, then run the applicable private checks with the replacement key.
5. After the canary succeeds, revoke the previous key in the provider console and
   remove its secret-store/managed-credential record. Record only redacted evidence
   in [`CHECKS.md`](CHECKS.md).
6. If the replacement canary fails before revocation, remove the enable flag (or set
   it to a value other than `1`) before new sessions and investigate without logging
   either key. If exposure is suspected, revoke the old key immediately and keep
   Kimi disabled until a newly issued replacement completes the canary; never roll
   back by re-enabling an exposed key.

## Canary and incident response

Before wider use:

1. Keep the provider disabled for existing/default agents: omit
   `RAVI_KIMI_CODE_ENABLED`, or set it to any value other than `1`, before they
   start new sessions.
2. For exactly one dev-agent canary process, set
   `RAVI_KIMI_CODE_ENABLED=1` before starting a new session and supply a newly
   issued dedicated credential only through the approved private mechanism.
3. Exercise text, one tool, two serialized tools, resume, abort, quota handling, and
   provider disable/re-enable.
4. Promote only when the release gates in `SPEC.md` and private checks in
   `CHECKS.md` pass.

The operator must be able to disable new `kimi-code` sessions without a deploy.
Removing `RAVI_KIMI_CODE_ENABLED`, or setting it to any value other than `1`, before
starting new sessions disables the canary. Disabling the provider must not translate
or delete existing provider state.

Trigger immediate disablement when any of these occurs:

- missing or duplicate terminal event;
- duplicate host tool execution;
- automatic replay after ambiguous acceptance or tool execution;
- credential, prompt, path, tool output, or reasoning sentinel in an unauthorized
  sink;
- repeated quota/unknown-limit requests before authorized reset;
- state corruption or resume across an incompatible profile/model.

After disablement, preserve only the minimum redacted diagnostic state allowed by
RAVI retention policy, revoke the dedicated key if exposure is possible, and leave
affected sessions in an explicit provider-unavailable/manual-recovery state. Do not
attempt cross-provider transcript conversion during an incident.

No public report, fixture, trace, screenshot, commit, or PR artifact may contain a
live prompt or response body, preserved reasoning, credential, authorization header,
or account identifier. Record only the redacted status required by
[`CHECKS.md`](CHECKS.md).

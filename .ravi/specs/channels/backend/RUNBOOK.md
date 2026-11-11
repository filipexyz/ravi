# Channel Backend / RUNBOOK

1. Admit one fixture wire ingress and inspect its durable receipt, Message,
   Session binding, Turn, and published correlation envelope.
2. Retry the same ingress before and after process restart; confirm one
   Message, one Turn, one prompt, and one stable binding.
3. Reuse the idempotency key with another fingerprint and confirm a closed
   conflict.
4. Fail prompt publication, retry, and confirm the accepted receipt resumes.
5. Admit one Slack root message and one thread reply through resolved ingress.
6. Fail Slack processing after Socket Mode ack; confirm the redacted envelope
   was durable before ack and is resumed without another provider delivery.
7. Confirm Slack uses its existing canonical Chat/Message and preserves route,
   subscription, actor, file, thread, and delivery-barrier metadata.
8. Run a fixture native driver through host-scoped wire ingress.
9. Project commentary, tool activity, terminal output, failure, and
   interruption and verify ordered readback.
10. Project commentary through a transport sink and confirm it receives the
    original external target, enters the durable outbound ledger by event ID,
    retries without duplication, remains separate from terminal output, and
    does not create a canonical Chat Message.
11. Project interrupted, sentinel, silent-token, heartbeat-only, no-response,
    and unknown-phase assistant content; confirm none enters commentary
    delivery.
12. Deliver one terminal assistant output and confirm the provider delivery
    identity attaches to the existing canonical Message without increasing
    the canonical Message count.
13. Move the Session to another Chat after the terminal job is enqueued and
    confirm delivery still validates against the accepted Turn binding.
14. Remove or mismatch the terminal canonical Message before handoff and
    confirm pre-send failure is closed; simulate the same mismatch after a
    successful provider send and confirm the provider-sent,
    canonical-rejected delivery record is published, its receipt terminates
    with the structural error, and bookkeeping retry never makes a second
    provider call.

## Internal Egress Version 2 Updates

Both `runtime_event` and `output` require egress version 2. Use the same runtime
bundle for the daemon and channel runner; mixed-version egress is unsupported.
Follow the existing [managed update coordination](../../permissions/provider-runtime/RUNBOOK.md#validate-update-coordination)
and [mixed-version recovery](../../permissions/provider-runtime/RUNBOOK.md#recover-a-mixed-version-channel-runner)
procedures. Do not add a v1 fallback or remove output restrictions.

Keep three checks separate:

1. Intake: coordinated updates stop channel intake before transitioning the
   daemon and restore the previously running managed processes. This does not
   prove that accepted turns or egress calls have drained.
2. In-flight work: distinguish persisted terminal state from durable outbound
   acceptance. Inspect existing outbound jobs independently. An unknown handoff
   outcome does not prove that no job was saved and does not authorize resending.
3. Readiness: confirm the daemon and runner use the intended bundle, inspect
   runner and adapter health, and verify a new inbound turn completes. PM2
   reporting online alone does not prove the egress path is ready.

A rejected runtime notification does not roll back terminal persistence or
prevent the independent terminal-output attempt. Commentary rejected before
outbound publication has not entered the delivery retry path. The coordinated
restart procedure is not a guarantee of lossless delivery for work in flight.

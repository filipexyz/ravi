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
10. Register two local actions with colliding scope/name and confirm discovery
   fails closed; invoke an authorized unique action in its exact source.

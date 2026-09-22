# Why Session Actions Need Their Own Spec

A channel may support an operation while one specific session cannot safely use
it. Sessions add chat subscriptions, default-output selection, permission scope
and ownership provenance.

Scoping only by agent and optionally by chat is insufficient: multiple sessions
can use the same agent, and an empty chat list previously widened the query.
Stable origin session provenance makes destructive targets auditable and
fail-closed.

Thread lifecycle actions also depend on session position, not only provider
capability. The same Slack surface can create a sibling thread while only a
thread child can close itself, so discovery must project session-aware
availability rather than advertise Slack API support alone.

`media.send` has the same class of mismatch. WhatsApp channel support can
list the action while the current turn snapshot lacks `media send`. Agents
then retry an advertised command and hit a gateway deny. Group origin is
not a special grant or a special revoke; the snapshot is. Discovery must
project that snapshot or keep channel status when none exists.

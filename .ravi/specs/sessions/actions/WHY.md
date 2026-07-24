# Why Session Actions Need Their Own Spec

A channel may support an operation while one specific session cannot safely use
it. Sessions add chat subscriptions, speech/output selection, permission scope
and ownership provenance.

Scoping only by agent and optionally by chat is insufficient: multiple sessions
can use the same agent, and an empty chat list previously widened the query.
Stable origin session provenance makes destructive targets auditable and
fail-closed.

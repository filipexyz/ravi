# Permissions / WHY

Ravi permissions decide who can read, execute, mutate, deliver, or disclose
state. The Permission Provider Runtime is the authorization surface for Ravi
core; runtime code must not embed a parallel permission graph.

The active model is turn-scoped agent identity. Actor, contact, chat, and
surface data are required provenance and compartment context, but unresolved
external actors still fail closed and receive no materialized authority.

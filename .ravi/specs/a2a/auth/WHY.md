# A2A Authorization / WHY

Remote agent access is not safe just because Ravi can resolve a credential.
Agent Cards describe possible authentication schemes, but Ravi still owns the
local policy decision: who may call the remote agent, which credential binding
may be used, and which task context is exposed after the call.

This spec prevents three classes of incidents: credential leakage into prompts
or metadata, cross-tenant task discovery through broad remote access, and model
choice of credential references without policy evidence.

# Why

## Decision

Voice agents must be first-class Ravi entities under `prox calls`.

Provider dashboards can store runtime details, but they cannot be the only source of truth for product behavior.

## Why Not Just `call_profile`

Profiles describe use cases. Voice agents describe who speaks and how.

If those are collapsed, changing a follow-up prompt can accidentally mutate the underlying persona/toolset used by interviews or urgent approvals.

## Why Not Ravi `agent`

Ravi agents own sessions and runtime work. Voice agents own live call behavior.

Reusing Ravi `agent` would mix text/coding/runtime concepts with telephony/voice provider concepts.

## Why Versioning

Calls are external human interactions. Later, Ravi must explain what voice/persona/prompt/tools were active when the person was contacted.

Provider dashboards mutate over time. Local versioning/snapshots preserve auditability.

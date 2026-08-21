# CRM CLI interface / WHY

## Rationale

Agents use the CRM CLI as a protocol. They need stable operation paths,
semantic arguments, bounded discovery, and errors that distinguish a missing
entity from a malformed call without scraping prose.

This spec stays at `cli/crm` so CRM follows the predictable `cli/<domain>`
shape. Shared envelope, exit, authorization, confirmation, and transport rules
remain in `cli`; this spec adds only CRM interface and error identities.

Controlled effects are separate. `crm/facade` is their normative owner, which
prevents the transport contract from becoming a second definition of domain
safety.

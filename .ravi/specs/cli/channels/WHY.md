# Channels config agent-first CLI contract / WHY

`ravi channels` is really two surfaces glued into one domain: a CONFIG surface
(list/show/create/set over local router-DB rows) that agents legitimately use
to wire providers to credential connections, and a PROCESS surface
(start/stop/restart/run/logs/probe/status over PM2) that manages an OS-level
runner. Only the first is agent-facing; the second has the same shape as
`daemon`/`service`, which the migration ledger dispensed ("Dispensados — sem
superfície de agente"). This spec therefore covers create/set/list/show and
explicitly leaves the runner lifecycle out, instead of pretending a dry-run
plan for `pm2 delete` would make an agent safer.

Create/set stayed unbraked because every write has a same-cost inverse:
`create` is an upsert reversed by `set enabled false`, and each `set` key can
be set back (nullable keys accept `-` to clear). The real risk in this domain
is not the write — it is the REFERENCE: pointing a channel at a credential
connection that does not exist, which used to fail as plain text. That is now
the cross-domain `CREDENTIAL_CONNECTION_NOT_FOUND` envelope (same code as
`cli/credentials`, id-only suggestions, no secret material) raised BEFORE the
config row is written.

The naming collision was a conscious decision: `CHANNEL_NOT_FOUND` already
exists in the `slack` domain meaning "Slack workspace channel". Reusing the
code here for "Ravi channel config" keeps the per-resource code convention
(one resource noun → one code), and the two are always distinguishable by the
envelope's `op` (`channels show` vs `slack ...`) plus the `suggestedAction`
each one carries. Inventing a second code (`CHANNEL_CONFIG_NOT_FOUND`) would
have traded a documented overload for a new vocabulary entry no other domain
uses.

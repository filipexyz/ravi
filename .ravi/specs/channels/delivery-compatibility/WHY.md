# Why a delivery-specific oracle

Readiness says a process is available. Threads compatibility says it understands
that domain's writes. Neither proves receipt-by-part or uncertain semantics.
Starting recovery beside an old or incompatible consumer can duplicate sends or
delete uncertain evidence. A positive aggregate version/identity comparison is
therefore necessary before any delivery effect, and missing evidence blocks.

This PR keeps the infrastructure inactive so code publication cannot accidentally
perform an uncoordinated schema cutover. Migration and process exclusion remain
separate obligations of the later controller integration.

# Why

A second operation catalog diverges from CLI/SDK validation and leaves remote
control dependent on a transport-specific authority model. The gateway can
share command semantics while keeping Console control authority distinct from
local agent authority. A short signed lease and durable execution receipt make
recovery explicit without claiming exactly-once external effects.

The origin contract prepares Console-owned channels and automations without
requiring a browser cookie or moving connectors as a side effect of this change.

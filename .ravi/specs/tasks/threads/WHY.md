# Why

The generic Thread storage already owns portable context. Tasks previously stored no
required relationship to it, dispatch retries created new assignments, and terminal
writes could partially succeed. Reusing Thread storage and the assignment as the admission
key gives a channel-free path without creating a competing execution system.

A transport acknowledgement is not proof of runtime admission or external delivery.
The frozen handoff and assignment receipt keep those facts separate. Ambiguous admission
sacrifices automatic replay rather than risk executing the same work twice.

Additive migration preserves IDs and queued data. Unknown legacy admission is explicitly
labelled, rather than guessing that an old assignment has never executed.

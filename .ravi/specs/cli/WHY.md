# Global CLI Contract / WHY

The contract is global because callers do not experience Ravi as 58 unrelated
domains. A process CLI, exported tool and SDK request can invoke the same
handler, pass through the same permission provider and emit the same audit.
Domain-only specs allowed those shared paths to drift even while individual
command tests passed.

The confirmation brake is valuable when it creates a real review boundary. It
blocks an outbound message, publication, irreversible action, authority change
or independently running job before the effect exists. Applying it to every
write or every paid API call trains agents to append `--execute` automatically
and turns the safeguard into ceremony.

The rollout evidence supports the underlying contract: compact fields reduced
representative list payloads substantially, error suggestions reduced repeated
help discovery and unsafe writes were blocked without reducing task completion.
That evidence does not excuse inconsistent transport behavior, mislabeled
permissions or consumer regressions. The global spec makes those constraints
reviewable together.

The main design boundary is:

- authorization answers whether the actor may perform the operation;
- confirmation answers whether this invocation needs a second deliberate call;
- transport adaptation answers how the same result crosses CLI/tool/HTTP;
- audit records what actually happened.

Keeping those four concerns separate prevents a `kind: "read"` label from
authorizing a mutation, prevents a local reversible write from gaining useless
friction, and prevents an exit-3 policy block from being recorded as a failed
execution.

Correcting an authorization label must not silently strand existing
least-privilege agents. The compatibility migration therefore adds only exact
mutate counterparts in the stores that remain authoritative across runs. It
does not rewrite historical runtime contexts and does not infer authority from
broad read wildcards; those cases need a human permission review because an
automatic expansion would grant more than the original command-level intent.

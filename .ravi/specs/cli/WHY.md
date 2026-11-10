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
does not rewrite historical runtime contexts. A broad or prefix read wildcard
is expanded only across the finite versioned inventory of operations it already
authorized, producing exact mutate grants instead of a broader mutate wildcard.

## Preserve diagnosis without exporting arbitrary exceptions

The masking audit found that media/transcription failures lost their provider
reason before reaching the user. Replacing that suppression with unrestricted
exception serialization exposed signed URLs, cookies, password tails and SDK
messages containing body/PII. Preserving diagnosis requires two distinct
controls: an ingress allowlist decides which fields may cross, and the shared
egress redactor protects values inside those fields.

Keeping the original throwable internally avoids losing evidence across
wrappers. Requiring cause/context at the user-failure constructor prevents new
headline-only envelope calls. Applying the same finite redactor at the output
boundaries prevents a relay, debug log or trace artifact from bypassing the
protection; a local stack dump is still an output and is excluded.

The AST ratchet freezes existing syntactic masking debt without requiring a
rewrite of every throw/catch. Its generated inventory makes remaining debt
public and its shrinking baseline prevents regression. Static binding usage
cannot prove semantic propagation through arbitrary dynamic code, so the
14-row/nine-sink corpus separately checks original cause/code preservation and
secret absence. Mocked Slack delivery and the TypeScript SDK are explicit
sinks; native SDK shape tests do not prove identical redaction algorithms.

The pattern set is finite and reviewable. Novel credential encodings require
new corpus evidence and a shared redactor change. See the generated
`design/error-cause-inventory.md` for current totals and remaining sites.

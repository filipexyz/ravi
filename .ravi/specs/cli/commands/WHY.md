# Ravi Commands agent-first CLI contract / WHY

`ravi commands` is the management surface for `#name` prompt shortcuts. Its
one deceptive op is `run`: the name suggests execution, but the implementation
only renders the composed prompt for preview — it never publishes to
`SESSION_PROMPTS` and never touches the runtime. That fact (already
documented in the commands skill) is what makes this a brake-free domain:
there is nothing destructive, irreversible or execution-dispatching to gate.
The migration's value here is the envelope and suggestions.

The not-found path is unusually cheap: `commands show`/`run` already built
the full registry (`discoverRaviCommands`) before the lookup failed, so
`COMMAND_NOT_FOUND` suggestions reuse `registry.commands` ids with zero extra
I/O. Agent resolution deliberately happens BEFORE discovery — an unknown
`--agent` fails from the in-memory config with `AGENT_NOT_FOUND` (same code
and shape as the `agents` and `skills` domains) without paying for a
filesystem scan whose result would be discarded.

One pre-existing behavior is intentionally preserved: `commands validate`
sets exit 1 when command files carry validation errors. That exit is a
verdict about the FILES, not an invocation failure, and renaming it to a
contract code would break the "validate in CI, non-zero on bad files"
pattern. The contract table lists it as-is.

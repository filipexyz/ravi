# Ravi Commands agent-first CLI contract / WHY

`ravi commands` is the management surface for file-backed `#name` prompt
shortcuts. Agents need more than output that happens to be JSON: they need to
distinguish a typo from an absent command, continue a list without guessing,
request compact fields safely, and know whether a call changed anything.

## Why the Domain Has No Write Brake

The deceptive operation is `run`. Its name suggests execution, but the
implementation only renders a composed prompt preview. It does not publish to
`SESSION_PROMPTS`, touch a runtime session, call a provider, or execute content
from Markdown. All four operations are reads, so exit 3 would be a contract
violation rather than protection.

## Why Validation Order Matters

Malformed command names are usage errors regardless of the requested agent.
Validating the name before agent resolution gives stable taxonomy and avoids
unnecessary config-dependent behavior. Once a name is valid, an unknown agent
still fails before filesystem discovery. A valid but absent command reaches
the registry so `COMMAND_NOT_FOUND` can reuse real ids as suggestions without
extra I/O.

## Why Fields Are Strict

Legacy COMMANDS silently ignored unknown field names. A mixed request such as
`id,unknown` returned only `id`, while `unknown` alone produced `{}` rows with
exit 0. For an agent, both cases make a typo look like trustworthy data.

The domain now opts into the shared strict-fields foundation. One unknown
field rejects the whole request and returns the stable accepted set, even when
no commands exist. Valid projections and the redundant `items`/`commands`
arrays remain compatible.

## Preserved Verdict

`commands validate` still sets exit 1 when command files contain validation
errors. That status is a verdict about the files, not an invocation failure.
Changing it to a typed contract error would break the established CI pattern
of using a non-zero result for invalid command definitions.

## Why the Proposed Facade Is Deferred

The natural-language facade in the domain dossier depends on unresolved
contracts: immutable registry revision, envelope integrity, real shadowing,
material-change classification, and engine routing. Implementing those choices
implicitly would weaken the read-only guarantee. This increment completes the
existing four-operation surface and leaves the future facade as an explicit
decision.

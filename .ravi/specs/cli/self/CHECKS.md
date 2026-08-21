# Self agent-first CLI contract / CHECKS

## Checks

- Every `self` op MUST remain read-only: context resolution runs with
  `touch: false, readOnly: true` and no DB/NATS mutation happens.
- No `self` op MUST accept `--execute` — the domain is declared brake-free and
  any brake appearing here is a regression of intent.
- `self context --fields identity,session --json` MUST return only the
  requested top-level sections, and the same projection MUST be printed even
  without `--json` when `--fields` is set.
- An unknown projected field MUST fail with `USAGE_ERROR`, exit 2 and the
  stable `acceptedFields`; `{}` exit 0 is forbidden.
- `self context --json` without `--fields` MUST keep the full packet
  (identity, actor, session, chat, route, recent, permissions, knowledge,
  explain, nextReads).
- The raw context key MUST never appear in any output, and sensitive metadata
  keys MUST print as `[redacted]`.
- `self recent --limit N` MUST pass the bound to the DB lookup and return at
  most N rows; limits outside 1..100 MUST fail clearly.
- Invalid `--depth` and `--limit` MUST expose `ARG_INVALID`, the offending
  value and corrective action in JSON, human, tool and gateway paths.
- Missing/unresolvable context MUST use `SELF_CONTEXT_REQUIRED` or
  `SELF_CONTEXT_UNAVAILABLE` exit 1; there is no entity universe to suggest.
- Root help MUST prefer a resolved context-registry record over ambient legacy
  env for identity and capabilities. Without a record, env MUST be labeled and
  capabilities MUST be unavailable rather than invented.
- Group help, `environment` output and the `environment_contract` explain step
  MUST name all actor env variables and their precedence without embedding
  their values.
- Env-derived actor data MUST be `partial`, `source: environment` and
  `trust: unverified`.
- Every SELF operation MUST have a concrete schema and no SELF command may
  appear in `WEAK_PUBLIC_RETURN_COMMANDS_BASELINE`.
- Human `self context` MUST render Actor, Chat and Route exactly once each.
- `bun test src/cli/commands/self.test.ts` SHOULD pass after any change to the
  self contract surface.

## Security addendum checks

- A fabricated inline context MUST fail through the local tool handler and the
  gateway dispatcher even when it grants itself SELF read capability.
- A tool invoked without an in-process bound context MUST fail with
  `TOOL_CONTEXT_REQUIRED`; a valid ambient or default credential MUST NOT be
  inherited.
- When `RAVI_CONTEXT_KEY` is explicitly present but invalid, context resolution
  MUST NOT fall through to a valid default credential or legacy `RAVI_*`
  identity.
- Unknown, expired and revoked registered contexts MUST retain distinct typed
  errors and MUST be resolved with `touch: false, readOnly: true`.
- Material changes to agent, session, source, capabilities, metadata, creation,
  expiry or revocation facts MUST produce `SELF_CONTEXT_DIVERGENT`.
- A session owned by another agent MUST produce
  `SELF_AUTHORITY_DIVERGENT` before any identity, working directory, chat,
  route or recent-message data is returned.
- Binding owner, chat owner, route owner and runtime provider contradictions
  MUST fail closed with only the failed relation in public details.
- `bun test src/cli/self-process.test.ts src/cli/context.test.ts
  src/cli/tools-export.test.ts` MUST cover the real invalid-key/default-key
  substitution path and the invocation-bound tool requirement.

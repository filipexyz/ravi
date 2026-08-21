# Agent-first CLI foundation / CHECKS

## Output integrity

- A native process test MUST parse a piped JSON response larger than 64 KiB.
- Success and failure paths MUST complete pending output before process exit.
- A permanently stuck stream MUST hit a bounded flush timeout without a busy
  loop, and termination MUST still complete.
- Native child-process checks MUST kill and observe a timed-out child before
  returning, so a failed check cannot leave an orphan process.
- The test MUST exercise the real CLI process boundary.
- Direct `fail()` termination MUST route through the top-level flush boundary.
- Native isolated tool tests with `RAVI_SUPPRESS_AUDIT_EVENTS=1` MUST NOT contact
  the global NATS audit transport.
- Interactive loops and child-process lifecycle callbacks listed in
  `RUNBOOK.md` MUST NOT be represented as migrated one-shot command exits.

## Public errors

- Expected safe failures MUST preserve their public code, message, retryability,
  suggested action, and exit code.
- Unexpected failures MUST NOT expose stack traces, SQL, paths, tokens, provider
  bodies, or internal exception messages.
- Invalid shared pagination values MUST return `USAGE_ERROR` with exit code `2`.

## Field selection

- One unknown field among valid fields MUST fail with `acceptedFields`.
- Only unknown fields MUST fail instead of returning empty objects.
- An empty result set MUST still validate requested fields.
- These checks apply to `agents list` in this foundation PR and to each command
  only after its domain declares a stable accepted field set.

## Effect metadata and brakes

- Agent-discoverable command manifests MUST include operation kind, effect
  class, risk, and confirmation requirement.
- The host runtime dynamic-tool catalog MUST preserve the same safety metadata
  instead of stripping it during projection.
- Legacy mutations without a reviewed effect class MUST be exported as
  `unclassified` with `classificationSource: legacy-unclassified`; they MUST NOT
  default to a safe class.
- The shared brake MUST have a native synthetic proof. Each real command
  requiring confirmation MUST add a domain-owned proof that its unconfirmed
  path performs no effect before leaving `unclassified`.
- A command's exported metadata MUST match its registered decorators and actual
  brake behavior.

## SDK drift portability

- Generated SDK comparison MUST accept only line-ending conversion and the
  already-informational `GIT_SHA` difference.
- Added, removed, or changed source content MUST continue to fail the drift
  check on every platform.

## Commands

- `bun test src/cli/commands/usage-exit.smoke.test.ts`
- `bun test src/cli/process-output.native.test.ts`
- `bun test src/cli/agent-contract.foundation.test.ts`
- `bun test src/runtime/host-services.foundation.test.ts`
- `bun test src/cli/pagination.test.ts`
- `bun test src/cli/tools-export.test.ts`
- `bun test src/cli/confirmation-policy.test.ts`
- `bun run test:agent-contract`
- `bun run test:sdk`
- `bun test src/sdk/client-codegen/codegen.test.ts`
- `bun run sdk:check`
- `bun run build`
- `bun run typecheck`

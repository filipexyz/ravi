# Task Dispatch Checks

## Ownership And Ports

- Runtime modules MUST NOT import work database functions directly; task reads
  MUST go through the typed work port.
- Work modules MUST NOT publish prompts or mutate session tables through untyped
  infrastructure; they MUST use the typed core session port.
- Port reads MUST return exactly one of `found`, `missing`, `unavailable`, or
  `unsupported`.
- `unavailable` MUST NOT be treated as `missing`; `unsupported` MUST NOT be
  treated as `found` or `missing`.

## Dispatch Intent And Acceptance

- A dispatch MUST atomically persist the assignment and a stable dispatch intent
  in work storage.
- The dispatch key MUST be stable across retries and derived from durable
  identifiers.
- A dispatch MUST reach `enqueued` only after a durable core enqueue receipt is
  recorded against the intent.
- A dispatch MUST reach `accepted` only after a matching runtime acknowledgement
  carrying the same dispatch key and payload hash.
- Enqueue success alone MUST NOT be recorded as acceptance.
- Core unavailability, enqueue failure, timeout, or crash MUST leave retryable
  evidence and MUST NOT create false `accepted` state.

## Idempotency And Payload Conflict

- Replay with the same dispatch key and payload hash MUST NOT create a second
  assignment, prompt, or acceptance.
- Reusing a dispatch key with a different payload hash MUST fail closed into
  `payload_conflict` and surface repair evidence.

## Unavailable-State Safety

- Session eviction MUST defer when active-task status cannot be confirmed.
- The `after_task` delivery barrier MUST defer (never deliver) on an
  unresolvable active-task check.
- Task runtime option resolution MUST fall back to safe core-only defaults and
  MUST NOT fabricate a task binding.
- Task acceptance MUST NOT be recorded while the work store is `unavailable`.

## Return Contracts

- Public dispatch CLI/SDK return contracts MUST remain concrete.
- `@CliOnly()` and weak return-schema baseline expansion MUST NOT be used to
  avoid concrete dispatch schemas.

## Commands

- `ravi specs sync --json`
- `ravi specs get tasks/dispatch --mode checks --json`
- `bun test src/specs/service.test.ts src/cli/commands/specs.test.ts`
- `bun test src/tasks/service.test.ts`
- `bun run typecheck`

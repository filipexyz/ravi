# Verified PR publication / CHECKS

- `bun test src/cli/commands/pr-approval.test.ts src/cli/command-access.test.ts`
  exercises `pr.publish` through the real gateway dispatcher with a signed
  external authority requiring approval. HTTP 403 / `PERMISSION_DENIED`,
  and both denial-guidance inputs MUST name the same way out. Persistence and
  emission retain their existing sanitization of those inputs.
- `bun test src/cli/commands/pr.test.ts src/pr/context.test.ts src/cli/command-access.test.ts`
  proves both callers. A runtime context with no authenticated session
  (unauthenticated, ambient identity, sessionless) stops with
  `PERMISSION_DENIED` before body/GitHub/health/journal IO, whatever
  `--reply-session` names; expired/revoked contexts fail; a session names only
  itself; authenticated preview/execution succeed with the public context ID
  and no key in the journal. The terminal is admitted at command admission and
  stops before any IO, with or without a stored default credential: with
  `PUBLICATION_SESSION_REQUIRED` (exit 2) when it names no session and with
  `SESSION_NOT_FOUND` when the session it names is not there. It publishes
  into the session it names, recorded as `local-operator` with no context ID.
  A session store the daemon has not prepared is refused for both callers and
  for the follow with `STATE_SCHEMA_NOT_READY` and the command that prepares
  it; it is never reported as a missing session, and refusing does not create
  the store.
- `bun test src/cli/commands/pr.test.ts` covers an expired or revoked session
  context returning `RUNTIME_CONTEXT_INACTIVE` (never `PERMISSION_DENIED`) while
  a missing grant stays `PERMISSION_DENIED`.
- `bun test src/cli/commands/pr-process.test.ts` runs the real CLI as a
  process and verifies that a terminal refusal is printed once, as the JSON
  envelope on stdout or as text on stderr, with its exit code.
- `bun test src/pr/ src/cli/commands/pr.test.ts` verifies real temporary Git
  databases on both ends, binary/path/mode fidelity, deletions, merges and
  identity offsets; preview, authority, caller cwd, leases and interrupted
  upload/ref/PR/follow recovery. No production repo/ref is mutated by tests.
- `bun test src/hooks/gh-pr-publish.test.ts src/hooks/gh-watch.test.ts`
  verifies PR reuse/ready, conflicts and existing follow reconciliation.
- `bun test --preload ./src/test/isolated-runtime-preload.ts src/hooks/gh-pr-publish.test.ts src/triggers/triggers.test.ts`
  verifies publication and reconciliation from a channel context carrying
  `instanceId`/`canonicalChatId` against actual trigger persistence. Only the
  existing destination fields are stored. Real destination or repository/PR
  mismatches and missing destinations still fail before the runtime probe.
- `bun test src/triggers/__tests__/runner-delete.test.ts src/watch/local-runner.test.ts`
  verifies actual loaded trigger fingerprints versus unconsumed DB changes,
  stop state and local CI producer behavior.
- `bun test src/cli/remote-gateway.test.ts` preserves safe publication plans and
  partial failure details while excluding secret/unrelated payload fields.
- SDK/OpenAPI generation and drift checks include `pr.publish` and its typed
  output; the command is available to gateway and tool consumers.
- Rendered command help and the runbook describe both callers and state that
  `--reply-session` names a destination and grants no authority.
- A live authorized smoke must verify remote SHA/tree against local Git,
  ready PR, active follow and receipt of CI events in the selected session.
  Build and the complete test suite belong in CI, not the production machine.
- `bun test src/pr/follow-broker.test.ts` starts an isolated in-memory NATS
  broker on an ephemeral loopback port and verifies actual delivery of PR,
  CI and comment subjects. It skips explicitly when `nats-server` is absent;
  topic reconciliation remains covered by the always-on helper tests.

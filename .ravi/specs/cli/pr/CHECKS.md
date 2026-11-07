# Verified PR publication / CHECKS

- `bun test src/pr/ src/cli/commands/pr.test.ts` verifies real temporary Git
  databases on both ends, binary/path/mode fidelity, deletions, merges and
  identity offsets; preview, authority, caller cwd, leases and interrupted
  upload/ref/PR/follow recovery. No production repo/ref is mutated by tests.
- `bun test src/hooks/gh-pr-publish.test.ts src/hooks/gh-watch.test.ts`
  verifies PR reuse/ready, conflicts and existing follow reconciliation.
- `bun test src/triggers/__tests__/runner-delete.test.ts src/watch/local-runner.test.ts`
  verifies actual loaded trigger fingerprints versus unconsumed DB changes,
  stop state and local CI producer behavior.
- `bun test src/cli/remote-gateway.test.ts` preserves safe publication plans and
  partial failure details while excluding secret/unrelated payload fields.
- SDK/OpenAPI generation and drift checks include `pr.publish` and its typed
  output; the command is available to gateway and tool consumers.
- Rendered command help and the runbook state that publication requires an
  authenticated gateway context and daemon journal. They do not promise that
  `--reply-session` alone enables a bare operator terminal to publish or grant
  it writable local access to runtime state.
- A live authorized smoke must verify remote SHA/tree against local Git,
  ready PR, active follow and receipt of CI events in the selected session.
  Build and the complete test suite belong in CI, not the production machine.
- `bun test src/pr/follow-broker.test.ts` starts an isolated in-memory NATS
  broker on an ephemeral loopback port and verifies actual delivery of PR,
  CI and comment subjects. It skips explicitly when `nats-server` is absent;
  topic reconciliation remains covered by the always-on helper tests.

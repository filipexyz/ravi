# Checks

- Run `bun test src/tasks/thread-core.test.ts` with an isolated state directory: creation,
  dispatch, consumer admission and completion must succeed without chat/subscription/channel
  lifecycle records.
- Verify creation retries keep task and Thread IDs, and differing input with the same key
  fails without creating another Thread.
- Inject a failure into task event creation and into result entry insertion; verify all
  affected rows roll back, including task/assignment terminal state.
- Verify concurrent/repeated delivery admits one frozen envelope, including after database
  reopen. An exception after claim must retain uncertain and never call the handler again.
- Verify task decisions and undelivered answers block completion.
- Run `bun test src/runtime/prompt-subscription.test.ts`: assignment admission precedes the
  runtime callback, and duplicate task delivery is acknowledged without another callback.
- Run focused task service, auto-resume, task DB and generic Thread suites. No full suite,
  package installation, heavy build, daemon restart or production migration is required locally.
- Verify the backfill fixture preserves session keys, task/assignment IDs and pending payload
  bytes, and a second migration does not add another task Thread.
- Verify generic Thread status changes refuse task-owned Threads; task completion remains the
  only successful closure writer.

- Run `bun test src/runtime/intake-failure.test.ts`: task receipts bypass debounce, cannot
  fall back to another agent and revalidate identity after dispatch preflight.
- Verify active accepting/admitted/uncertain assignments cannot be replaced with a second
  executor, and publication retry after executor expiry preserves the frozen session key.

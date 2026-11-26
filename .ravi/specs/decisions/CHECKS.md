# Checks

- `bun test src/decisions/decisions.test.ts` MUST preserve legacy fields, history and provenance, reject stale ids/self-answer/sibling access, and verify one admission, retry and uncertain recovery.
- `bun test src/router/chat-schema.test.ts` MUST migrate on DB open and preserve unrelated canonical chats.
- `bun test src/cli/commands/decisions.test.ts` MUST validate concrete return shape, usage errors, provenance and effect-free thread preview.
- `bun test src/tasks/decisions.test.ts src/tasks/task-authorization.test.ts` MUST retain parked and inherited task authority.
- `bun test src/channels/slack/thread-card.test.ts src/channels/slack/thread-lifecycle.test.ts` MUST preserve card fallback/lifecycle and reject close with pending decisions.
- `bun test src/runtime/prompt-subscription.test.ts` MUST route decision envelopes through durable admission without another turn on duplicate receipt.
- SDK client, Dart, Swift and both OpenAPI drift checks MUST match the registry; full suite runs in CI.
- Wait-summary fixtures MUST cover open questions; pending/publishing/published/accepting/failed/uncertain answers; delivered/superseded exclusion; multiple deliveries per decision; a new question alongside an older answer; and separate lifecycle origins for threads of the same agent, excluding tasks. Listing MUST change no database rows and preserve close refusal. Uncertain admission yields counts 1/1, then 0/0 after confirmed admission. Sessions human output MUST render singular/plural admission and uncertainty cues only for positive counts, with matching JSON fields.

- Nested runtime identity MUST retain actor/relay provenance and refuse active-worker self-answer for both origins. Explicit read-only grants MUST NOT permit answers.
- Concurrent answer admission MUST invoke the dispatcher once; closure MUST remain blocked while admission is in progress. Reconciler interleaving across a rename MUST preserve the frozen outbound job.
- A daemon-spawned shell automation MUST NOT resolve uncertain delivery as the local operator.
- Decision prompts MUST bypass debounce and reject a missing assigned agent, with a retryable receipt. Existing non-decision dispatch behavior MUST remain unchanged.
- Waiting-card notification text MUST escape Slack mention syntax and respect the subtitle bound; sessions-skill decision examples MUST remain covered by execute-consumers tests.
- `bun test src/decisions/decision-scopes.test.ts` MUST prove: an agent (even with every grant) cannot widen without an owner message naming the decision id and the scope (a quote alone, the id alone or another scope are refused); the operator can, a daemon-spawned automation cannot; wide answers fit 2000 characters; a proposed wide scope binds an answer unless narrowed; a source neither naming the id nor containing the quote is refused and the quote is stored; a provider id repeated in more ineligible chats than the row limit still resolves; second-unit provider timestamps; a turn carries org, its agent and its own thread only (no project), newest 20; a live runtime gets the current list only when it changed; supersede leaves history, removes the old from turns, withdraws its undelivered answer, refuses an older replacement and the waiting worker, and its authority rules.
- `bun test src/runtime/runtime-system-prompt.test.ts` MUST mount `decisions.in_force` with quoted answers for a non-sentinel agent and never for a sentinel.
- Independent review of #1030 @ c67913f MUST stay covered: a designated owner who is not the installation owner never widens nor sources a wide replacement; the owner's message must contain the answer text; negations and a scope away from the id never widen; org decisions reach only `org-internal` agents.

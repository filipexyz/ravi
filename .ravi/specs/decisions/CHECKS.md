# Checks

- `bun test src/decisions/decisions.test.ts` MUST preserve legacy fields, history and provenance, reject stale ids/self-answer/sibling access, and verify one admission, retry and uncertain recovery.
- `bun test src/router/chat-schema.test.ts` MUST migrate on DB open and preserve unrelated canonical chats.
- `bun test src/cli/commands/decisions.test.ts` MUST validate concrete return shape, usage errors, provenance and effect-free thread preview.
- `bun test src/tasks/decisions.test.ts src/tasks/task-authorization.test.ts` MUST retain parked and inherited task authority.
- `bun test src/channels/slack/thread-card.test.ts src/channels/slack/thread-lifecycle.test.ts` MUST preserve card fallback/lifecycle and reject close with pending decisions.
- `bun test src/runtime/prompt-subscription.test.ts` MUST route decision envelopes through durable admission without another turn on duplicate receipt.
- SDK client, Dart, Swift and both OpenAPI drift checks MUST match the registry; full suite runs in CI.

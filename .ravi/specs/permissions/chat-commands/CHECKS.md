# Checks

- A command older than 60 seconds, or stamped in the future, MUST NOT run, and a command that goes stale while the access metadata loads MUST NOT run.
- A person nobody linked to a contact MUST get a refusal and MUST NOT run any operation; static commands need no contact and MUST be answered even when the identity lookup fails.
- A contact without access to the session MUST NOT read it; a contact with access but without `modify` MUST NOT close a thread, close idle threads (`close idle` included) or stop a turn, and no operation, thread listing or runtime request MUST happen before the refusal.
- A contact that modifies the session but lacks the CLI's capability for the operation MUST be refused, and the check MUST run as `channel-command` with the contact as subject.
- When the CLI's declared access cannot be read the command MUST be refused.
- A chat whose route forces a session of another agent, a chat with no route and a route whose session does not exist MUST NOT run a command and MUST say why.
- `close idle` MUST skip busy threads, threads with an open question, an undelivered answer or a pending return, and threads with recent activity; it MUST count only its own closes and MUST bound the tries.
- `stop` MUST tell nothing running, session not active, a failure code, a timeout and an unreachable runtime apart.
- `stop <thread>` MUST interrupt the thread's own session and not the chat's, MUST ask the rights of a plain `stop` before the thread is looked up, MUST say a thread not found or with no session left, and MUST say `threads_unsupported` for a channel with no thread lookup.
- A command that changes state (`close`, `close idle`, `stop`) whose declared access is not `mutate` MUST be refused as `access_metadata_missing`, and nothing MUST be listed, closed or interrupted.
- The audit row MUST carry `surface` when the channel supplies it and MUST NOT carry the key when it does not.
- A channel with no threads MUST be told `threads_unsupported` for `threads`, `close` and `close idle`, and `status` MUST omit the thread count.
- Every command MUST be audited on `ravi.audit.chat_command` with the channel as a value and without the text typed; a failure anywhere MUST be answered and audited; an answer the channel cannot deliver MUST NOT stop the audit.
- The engine MUST NOT load a channel's own CLI command (`cli/commands/sessions.js`, which closes Slack threads and imports Slack's thread code): the channel declares the access of the command that closes its threads, and a command that needs it and gets none MUST be refused.
- `src/chat-commands/` MUST NOT name any channel or import `channels/`; `src/cli/command-access.ts` and `src/permissions/provider-types.ts` MUST NOT name any channel.
- `bun test src/chat-commands/ src/cli/command-access.test.ts` MUST pass.
- `bun run typecheck` MUST pass.

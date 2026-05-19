---
id: threads
title: "Threads"
kind: domain
domain: threads
status: draft
normative: false
---

# Threads Checks

## Storage

- Creating a thread without links succeeds.
- Creating a thread with duplicate slug in the same scope fails with a clear conflict.
- Renaming a slug preserves the stable thread id.
- Adding a note appends a new entry.
- Closing a thread appends a status event.
- Deleting or archiving a thread does not delete linked chats, sessions, contacts, tasks, or artifacts.

## Links

- Linking `contact:<id>` stores a thread link and does not create a contact.
- Linking `chat:<id>` stores a thread link and does not create a chat.
- Linking `session:<key>` stores a thread link and does not mutate session identity.
- Raw provider ids are rejected or stored only as provenance behind a typed Ravi link.
- A thread with multiple outbound targets requires explicit target selection.

## Handoff

- `ravi sessions send <session> --thread <thread> "prompt"` resolves both target session and thread.
- The emitted prompt includes a bounded thread brief plus the operator prompt.
- The thread id appears in emitted source/context metadata.
- A `thread_handoff` row records target session, origin session, prompt, brief entry ids, and status.
- The command respects the same REBAC restrictions as `ravi sessions send` without `--thread`.
- The command fails closed if the caller cannot read the thread or cannot send to the target session.

## Safety

- A linked contact does not automatically grant outbound permission.
- A linked private chat does not cause full transcript injection by default.
- Source references from inaccessible chats are omitted from the brief with an audit-visible reason.
- Agent tools receive structured thread context; authorization does not depend on parsing the text brief.

## Regression Commands

After implementation, expected targeted validations:

```bash
bun test src/threads
bun test src/cli/commands/threads.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/runtime/thread-context.test.ts
bun run build
```

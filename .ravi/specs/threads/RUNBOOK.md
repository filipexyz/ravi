---
id: threads
title: "Threads"
kind: domain
domain: threads
status: draft
normative: false
---

# Threads Runbook

## Create A Lightweight Subject

```bash
ravi threads create rafa-pricing --title "Dúvidas com Rafa sobre pricing"
ravi threads note rafa-pricing "Validar se enterprise-first faz sentido antes de abrir self-serve."
```

Expected behavior:

- creates a Ravi-owned thread id;
- does not create a session;
- does not create a chat;
- does not write Knowledge by default.

## Link A Contact And Chat

```bash
ravi threads link rafa-pricing contact:<contact-id> --role participant
ravi threads link rafa-pricing chat:<chat-id> --role default-outbound
```

Expected behavior:

- records semantic Ravi ids;
- preserves raw provenance only if needed;
- does not infer permission to message the contact without outbound policy checks.

## Continue In An Agent Session

```bash
ravi sessions send dev --thread rafa-pricing "continua daqui e prepara uma pergunta objetiva pro Rafa"
```

Expected behavior:

- resolves the session normally;
- resolves the thread normally;
- builds a bounded thread brief;
- emits one prompt to the session containing the brief and operator prompt;
- writes a `thread_handoff` audit row.

## Debug Missing Context

Check:

1. Does the thread exist?
2. Does the caller have permission to read the thread?
3. Does the target session exist and is it accessible?
4. Did Ravi generate a thread brief?
5. Which entries and links were included in the handoff?
6. Was any entry omitted due to token budget, permission, private source, or missing source?
7. Did the runtime trace show the thread id in source/context metadata?

## Debug Unsafe Outbound

If an agent tried to message a person from a thread:

1. Confirm the thread has an explicit `contact` or `chat` link.
2. Confirm only one default outbound target is active for that channel/action.
3. Confirm contact policy allows outbound.
4. Confirm route/channel permission allows the sending session.
5. Confirm the thread handoff did not inject raw private source text from unrelated chats.

## Migration Guidance

Do not migrate Knowledge threads automatically into Threads.

Do not migrate provider-native thread ids into Threads.

Threads may link to existing sessions/chats/messages once canonical ids exist.

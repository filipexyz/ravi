---
id: threads
title: "Threads"
kind: domain
domain: threads
status: draft
normative: false
---

# Why Threads

## Problem

Ravi has chats, sessions, contacts, artifacts, tasks, and Knowledge, but none of those names exactly match the operator need for a lightweight "fio de assunto".

The missing primitive is:

- create a subject before an agent is involved;
- keep notes, questions, answers, and source links together;
- send that subject to an agent later;
- continue the same subject with another agent;
- ask a person from the subject when an explicit contact/chat target is linked;
- avoid copying the entire transcript into every runtime.

## Why Not Knowledge

Knowledge is the right place for curated, canonical, long-lived memory.

This thread concept is operational. It may contain drafts, unresolved questions, rough notes, temporary links, handoff context, and work-in-progress entries.

Knowledge can ingest from threads later, but requiring Knowledge for the happy path would make the UX heavier and blur the user's mental model.

## Why Not Session

A session is tied to a live agent runtime and provider state.

The user wants to create a thread without choosing an agent, then hand it to an agent later. That requires a Ravi-owned subject independent of runtime state.

## Why Not Chat

A chat is transport context. A thread can span a WhatsApp DM, a group, a CLI note, a task result, and an agent session.

Binding the subject to one chat would make cross-channel continuity hard.

## Why `ravi sessions send --thread`

The target runtime is still a session. The cleanest UX is to keep the target explicit:

```bash
ravi sessions send dev --thread rafa-pricing "continua daqui"
```

That command answers two questions at once:

- Which agent/runtime should continue now?
- Which thread context should be attached?

It also avoids hidden dispatch magic where a thread silently chooses an agent.

## Tradeoffs

- A new `threads` domain adds one more top-level concept, but it removes ambiguity between Knowledge, chat threads, provider threads, and sessions.
- The first implementation should keep entries and links simple. Curated extraction, summaries, and Knowledge publishing can come later.
- The first implementation should prefer explicit targets over automation. That keeps contact messaging safe while the model matures.

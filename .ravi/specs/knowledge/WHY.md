---
id: knowledge/why
title: "Ravi Knowledge Why"
kind: domain
domain: knowledge
status: active
normative: false
---

# Why Ravi Knowledge Works This Way

## Problem

What the organization knows is scattered: meetings recorded by the Ravi bot, published Ravi Pages, approved notes in the Console, and the local chat history and transcripts on the operator's machine. Agents answered from memory or not at all, and nothing showed where an answer came from.

## Decisions

- **One search, with sources.** The operator asks one question and gets meetings, pages, notes and local chats merged (reciprocal rank fusion), each with a ref, a trust tier and a url. Citing is cheaper than guessing.
- **Operator turns only.** Meeting speech and internal pages must not reach a contact or a group through a curious agent. The turn classifier and the Console both check the turn; any other audience gets exit 3 and no data.
- **Exposure gate before anything.** An agent that outsiders can reach and that can read files could leak the local index or `knowledge.db`. Until every such agent is chat-only or limited to an allowlist of capabilities, Knowledge refuses everywhere, including the terminal, so the fix is never postponed.
- **Quoted data, never instructions.** Excerpts come from people and pages Ravi does not control. Fences with a per-call nonce and neutralized text keep them from steering the agent. Display names in meetings are chosen by participants, so attribution says "attributed to".
- **Local stays local.** Chat history and contact memory never go to the Console. Only gap questions (what the contact asked and nobody answered) go up, so an org member can answer them on a card.
- **Own database file.** FTS5 tables do not fit the `ravi.db` column reconciler, chat history lives in `chat.db`, and an own file can be dropped and rebuilt.
- **Brakes where text leaves the machine.** `propose` sends text to the Console and `forget --redact` destroys it, so both dry-run first; the plan never echoes the body. Archiving is reversible and runs at once.
- **Write after read.** A turn that read unapproved content could forward it by a send, a publish or a scheduled job. Those commands ask the operator once per action.
- **Superseded design.** The earlier canonical-items, threads, profiles, curators and Obsidian publisher sub-specs described a vault-publication model that was never built. They are superseded by this spec and scheduled for removal.

## Accepted risks

- Forwarded messages look authored to `remember` (the envelope has no forward marker).
- Channel-backend turns bypass the gateway egress guard; such sessions get no packet.
- `runtime_prompt_queue` persists the per-turn preamble for crash recovery.

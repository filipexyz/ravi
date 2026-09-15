# Self agent-first CLI contract / WHY

`ravi self` exists so an agent can orient itself cheaply: identity, actor,
session, chat binding, route, recent metadata, capabilities. Two design
decisions define the contract:

1. **No brakes, ever.** The whole value of an orientation surface is that it
   is always safe to call. Every op is a read; `resolveRuntimeContextOrThrow`
   even runs with `touch: false` so a `self` call does not update
   `lastUsedAt`. Adding `--execute` anywhere here would teach agents that
   reads can be dangerous, which is the opposite of the domain's purpose.
   This is declared in the spec so future ops do not drift into writes.

2. **No `*_NOT_FOUND` envelope.** The domain has no user-supplied entity ids
   to look up — the "entity" is the caller's own context, resolved from the
   environment. When that context is missing the correct answer is the
   existing loud failure (`Missing RAVI_CONTEXT_KEY`), not a suggestions
   envelope: there is nothing similar to suggest.

The contract work therefore concentrated on compact mode. `self context` is
the largest read payload of the CLI (identity + actor + session + chat +
route + recent + permissions + knowledge + explain), and agents were pulling
all of it just to read one section. `--fields` projects top-level sections via
the shared `pickFields`, and with `--fields` set the human printer is bypassed
in favor of the projected JSON — a partial packet rendered through the full
text printer would be misleading (sections silently absent).

Skill gap: `self` ships no SKILL.md today. The payloads self-document via
`nextReads`, but the gap is registered in the spec's consumers section so the
skills backlog picks it up.

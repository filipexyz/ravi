# Runtime Session Visibility Rationale

## Why One Provider-Neutral Payload

Operators and tools need one answer for session state regardless of whether the
turn runs in Claude Code, Codex, or Pi. Exposing provider-native payloads would
move normalization into every consumer and make authorization, diagnostics,
and user interfaces disagree about the same session.

The Ravi payload therefore keeps a stable shape and represents unsupported
values explicitly. A missing provider signal becomes `null`, `unknown`, or an
empty conservative projection; it never becomes an optimistic guess.

## Why Skill Records And `loadedSkills` Both Exist

Discovery, synchronization, prompt advertisement, and loading are different
states. The detailed `skills` records preserve that distinction and retain the
evidence needed to explain it. `loadedSkills` remains a compatibility projection
for consumers that only need the small, enforcement-safe set proven loaded.

This split prevents a catalog entry from silently becoming authorization
evidence. It also lets older consumers keep working while newer ones show the
full state and its confidence.

## Why Pi Advertises Without Claiming Load

Pi can receive an allowlist-filtered skill catalog and instructions for reading
a skill through the public Ravi CLI, but its RPC surface has no native
skill-loaded event. Recording the catalog as `advertised` with declared
`system-prompt` evidence is useful and truthful. Projecting those entries into
`loadedSkills` would be false evidence, so that vector stays empty until Ravi
observes an explicit load.

## Alternatives Rejected

- Scraping provider text was rejected because formatting is unstable and cannot
  prove what remains in the current context window.
- Treating local files or synchronized skills as loaded was rejected because
  presence on disk does not prove provider ingestion.
- Performing a provider round-trip on every query was rejected because
  visibility must be fast, read-only, and available during degraded operation.

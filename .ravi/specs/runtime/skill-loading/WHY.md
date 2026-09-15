# Runtime Skill Loading Rationale

## Why Loading Requires Evidence

A skill can exist in a plugin, be copied into provider storage, appear in a
prompt catalog, or be requested without its body being present in the active
context. Authorization and skill gates cannot safely collapse those states.

Ravi therefore records a state, confidence, source, and evidence trail for each
skill. Only `state=loaded` with `confidence=observed` enters the compatibility
`loadedSkills` vector.

## Why The Model Is Provider-Neutral

Claude Code, Codex, and Pi expose different discovery and runtime signals. The
adapter translates those signals into one Ravi model so consumers never infer
security state from a provider name. Ambiguous signals resolve conservatively
to `requested`, `advertised`, or `unknown`.

## Why Compaction Resets Loaded State

Compaction changes the live context window. Even when a provider may preserve
some text internally, Ravi cannot prove that the exact skill body survived in a
form suitable for enforcement. Resetting the loaded projection forces the next
protected action to establish fresh evidence.

## Why Pi Gets A Catalog

Pi benefits from knowing which allowlisted Ravi skills are available and how to
read them, even though it cannot emit a native loaded-skill event. The catalog
is therefore represented as `advertised` with declared `system-prompt`
evidence. This improves discoverability without pretending the skill body is
already loaded.

## Alternatives Rejected

- Trusting filesystem presence was rejected because synchronization is not
  provider ingestion.
- Treating a prompt mention as loaded was rejected because a name is not the
  skill body.
- Keeping loaded state across compaction was rejected because it would turn
  stale evidence into an authorization bypass.

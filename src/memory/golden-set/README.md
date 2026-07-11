# Memory Curation Golden Set (R24)

Versioned fixtures that gate any change to the curator prompt or judgment
model. Each JSON file describes one session-shaped scenario and the expected
save/skip/stage decision anchored to a specific invariant (R4 / R14 / R15 /
R20). The suite is consumed by `ravi eval` and by
`src/memory/golden-set.test.ts` (schema-well-formedness). Change the prompt
or the model → this suite MUST re-run and pass before merge.

## Fixture schema

```jsonc
{
  "id": "kebab-case-unique",
  "invariant": "R4 | R14 | R15 | R20",
  "description": "One sentence — what does this fixture prove?",
  "transcript_excerpt": "Verbatim slice a curator would see",
  "candidate": {
    "title": "Human-readable title of what the curator would extract",
    "content": "The proposed memory entry text",
    "type": "user | feedback | project | reference",
    "identity_key": "slug used for R14 supersession match"
  },
  "existing_entry": null, // or { title, identity_key, content } to force R14
  "expected": {
    "action": "save | skip | stage-hitl",
    "reason": "R4:env-failure | R4:claim-negativo-tool | R5:skill-candidate | R14:conflict-staged | R15:staleness-staged | R20:spec-candidate | R20:vault-candidate | R20:skill-candidate | ok",
    "note": "Optional — free-text rationale for the reviewer"
  }
}
```

## Adding a new fixture

1. Drop a JSON file matching the schema above into this directory
2. Run `bun test src/memory/golden-set.test.ts` to verify the schema check
3. When the LLM curator is wired in a downstream `ravi eval` spec, add the
   fixture id to that spec's covered set

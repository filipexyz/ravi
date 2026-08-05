# Runtime Skill Loading Checks

## Automated Checks

```bash
bun test src/runtime/session-visibility.test.ts src/runtime/session-trace.test.ts src/runtime/skill-gate.test.ts
bun test src/runtime/claude-provider.test.ts src/runtime/codex-provider.test.ts src/runtime/pi-provider.test.ts
bun test src/runtime/allowed-skills.test.ts src/runtime/provider-contract.test.ts
```

## State And Evidence Assertions

- A new session MUST begin with an empty `loadedSkills` vector.
- Canonical skill ids MUST come from frontmatter names rather than paths or
  aliases.
- Available, synchronized, advertised, requested, stale, and unknown records
  MUST NOT enter `loadedSkills`.
- Only observed load evidence MUST create a loaded projection.
- A successful Ravi-owned `skills show` read MUST record canonical `tool-call`
  evidence.
- Provider metadata invalidation MUST refresh catalog state without fabricating
  a loaded-state transition.
- Compaction and explicit session reset MUST clear loaded state in live and
  persisted snapshots.

## Provider Assertions

- Claude plugin discovery alone MUST NOT be a loaded signal.
- Codex synchronization and `skills/list` MUST remain synchronized or
  advertised until matched instruction-source or Ravi-owned read evidence
  exists.
- Pi MUST filter the catalog through the agent allowlist, advertise it in the
  system prompt, and keep `loadedSkills` empty without explicit load evidence.
- The provider contract MUST expose the same skill-visibility capability shape
  for Claude Code, Codex, and Pi.

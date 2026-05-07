# Checks

```bash
bun test src/cli/commands/contacts.test.ts
bun test src/session-trace/session-trace-db.test.ts
bun test src/tasks/profiles.test.ts src/cli/commands/tasks-profiles.test.ts
bun run typecheck
bun run build
```

Manual checks:

```bash
ravi tasks profiles show contact-profile-research --json
ravi tasks profiles preview contact-profile-research --title "Research Luis profile" --input target_contact_id=d8f3d5ad489d --json
ravi contacts profile d8f3d5ad489d --json
ravi contacts sessions d8f3d5ad489d --json --limit 5
ravi contacts messages d8f3d5ad489d --json --limit 5
ravi contacts activity d8f3d5ad489d --json --limit 5
ravi contacts activity d8f3d5ad489d --json --raw --limit 5
```

Expected properties:

- `contact-profile-research` is not present in `src/tasks/profile-catalog/system-profiles.json`
- commands resolve the target to a canonical contact id
- raw channel ids appear as provenance, not as the primary contact model
- profile includes contact, identities, policy, metadata, timeline, messages, sessions, and activity
- empty evidence surfaces return typed empty lists, not command failures
- pagination metadata is present for list-like sections
- `contacts activity` defaults to high-signal events; `--raw` includes low-level runtime/tool/adapter events

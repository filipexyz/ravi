# Runtime Session Visibility Runbook

## Inspect A Session

1. Resolve the exact Ravi session name or key.
2. Run `ravi sessions visibility <session> --json`.
3. Check `lastUpdatedAt` before interpreting token, compact, or skill state.
4. Read `skills[].state`, `confidence`, `source`, and `evidence` together.
5. Treat `loadedSkills` as the conservative compatibility projection, not as a
   catalog of everything available to the provider.

## Debug Missing Or Stale Skill State

1. Confirm the skill is visible to the agent with
   `ravi skills inspect --agent <agent> --json`.
2. Inspect the session trace around provider start, tool completion, compaction,
   and reset events.
3. Compare live state with persisted `runtimeSessionParams.skillVisibility`.
4. If the provider only advertises the skill, expect `state=advertised` and an
   empty `loadedSkills` vector.
5. For Pi, verify that only allowlisted skills reached the system-prompt catalog
   and that their evidence is declared `system-prompt` evidence.
6. For an explicit Ravi skill read, verify the successful tool completion was
   normalized to the canonical frontmatter name.

## Debug A Compact Or Reset

1. Find the compact/reset boundary in the runtime trace.
2. Confirm the persisted and live `loadedSkills` projections reset together.
3. Confirm previously loaded records are no longer used as current enforcement
   evidence.
4. Re-query visibility after the boundary rather than relying on a cached client
   response.

## Change Procedure

1. Update the provider adapter and shared visibility model together.
2. Preserve the provider-neutral response shape and conservative defaults.
3. Add provider-specific evidence tests without weakening the shared invariant.
4. Run the checks in `CHECKS.md` and then the repository quality gate.

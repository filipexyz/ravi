# Runtime Skill Loading Runbook

## Inspect Skill State

1. Confirm agent visibility with `ravi skills inspect --agent <agent> --json`.
2. Query `ravi sessions visibility <session> --json`.
3. Locate the canonical skill id in `skills` and inspect its state, confidence,
   source, evidence, and timestamps.
4. Inspect `loadedSkills` separately; absence is expected for available,
   synchronized, advertised, requested, stale, and unknown records.

## Verify An Explicit Ravi Skill Read

1. Run `ravi skills show <skill> --json` inside the target runtime context.
2. Confirm the command succeeds and resolves the canonical frontmatter name.
3. Inspect the tool-completion event in the session trace.
4. Query visibility again and verify Ravi recorded observed `tool-call` evidence
   before projecting the skill into `loadedSkills`.

## Add Or Change A Provider

1. Document the provider's discovery, advertisement, request, load, invalidation,
   compact, and reset signals.
2. Map each signal to the shared state and confidence enums.
3. Prefer `unknown` when no provider-native or Ravi-owned evidence exists.
4. Keep catalog filtering aligned with the agent skill allowlist.
5. Emit and persist the normalized snapshot at provider event boundaries.
6. Add tests proving non-load signals never enter `loadedSkills`.

## Pi Diagnostics

1. Verify the agent allowlist before provider startup.
2. Inspect the appended system prompt for canonical skill names and public
   `ravi skills show` loading instructions.
3. Expect the records to be `advertised` with declared `system-prompt` evidence.
4. Expect `loadedSkills` to remain empty until a successful Ravi-owned read is
   observed.

## Compact Or Reset Diagnostics

1. Find the compact/reset event in the runtime trace.
2. Confirm live and persisted loaded projections reset atomically.
3. Confirm subsequent gates require new observed evidence.

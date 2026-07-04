# Events / Gap Analysis / RUNBOOK

## How To Use This Analysis

### 1. Review the prioritized matrix

Open the SPEC.md and review the 16 candidates in the matrix. Each candidate includes:

- Proposed subject(s)
- Classification (`public-trigger`, `replay-only`, `internal-control`)
- Payload sketch
- Value/risk/effort scores
- Affected specs

### 2. Validate current coverage

```bash
# Check audit stream subjects
bun test src/events/audit-stream.test.ts

# Check trigger topic catalog
bun test src/triggers/topic-catalog.test.ts  # if exists

# List all ravi.* subjects in the codebase
rg 'nats\.emit\(' src/ --no-filename | grep -oP '"ravi\.[^"]+' | sort -u
```

### 3. Verify no new publishers were added

This analysis is a point-in-time snapshot. If new `nats.emit()` calls have been added since this analysis, re-run:

```bash
rg 'nats\.emit\(' src/ --no-filename -g '!*.test.*' | grep -oP '"ravi\.[^"]+' | sort -u > /tmp/current-publishers.txt
```

Compare against the "Actual Publishers" table in SPEC.md.

### 4. Create follow-up implementation tasks

For each recommended candidate:

1. Confirm the classification (public-trigger vs replay-only) with a human reviewer.
2. Validate the payload sketch contains no sensitive fields.
3. Create a scoped implementation task covering:
   - Publisher implementation in the relevant source file
   - Audit stream subject addition (if not already covered by existing wildcards)
   - Trigger catalog entry (for `public-trigger` candidates)
   - Test coverage

### 5. Inspect existing event coverage per domain

```bash
# Session events
rg 'ravi\.session\.' src/events/audit-stream.ts

# Trigger events
rg 'ravi\.triggers?\.' src/ --no-filename -g '!*.test.*' | sort -u

# Cron events
rg 'ravi\.cron\.' src/ --no-filename -g '!*.test.*' | sort -u

# Permission events
rg 'ravi\.audit\.' src/ --no-filename -g '!*.test.*' | sort -u

# Contact events
rg 'ravi\.contacts\.' src/ --no-filename -g '!*.test.*' | sort -u
```

## Common Pitfalls

- **Adding events to the trigger catalog without privacy review.** Events classified as `replay-only` or `internal-control` MUST NOT appear in the trigger catalog until a human confirms the payload is safe for routine consumption.
- **Including raw prompts, context keys, or user data in payloads.** All proposed payloads use opaque ids and safe metadata only.
- **Treating this analysis as a task list.** Candidates are recommendations. Implementation requires human review and separate scoped tasks.
- **Confusing CLI audit events with lifecycle events.** `ravi.*.cli.triggers.*` captures "the CLI command ran" — it is not a substitute for `ravi.trigger.fired` which captures "the trigger fired in the runtime".

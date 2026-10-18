---
id: knowledge/runbook
title: "Ravi Knowledge Runbook"
kind: domain
domain: knowledge
status: active
normative: false
---

# Ravi Knowledge Runbook

## Enable for an agent

1. Make sure no outsider-reachable agent can read files:

   ```bash
   ravi doctor --json
   ```

   If `permissions.knowledge_exposure` fails, make the listed agents chat-only (`ravi agents permissions <id> chat-only`) or close their outside routes.

2. Grant the agent Knowledge:

   ```bash
   ravi agents permissions main explicit-only --capabilities use:tool:Bash,execute:executable:ravi,read:knowledge:*,mutate:knowledge:remember --execute
   ```

3. Log in to the Console (`ravi login`) so Console results are included. Without it, searches return local history only with `issues: ["console_not_logged_in"]`.

## Search fails with exit 3

| Code | Action |
|---|---|
| `KNOWLEDGE_EXPOSURE_UNSAFE` | Read `issues` (up to 5 offending agents) and fix them as above |
| `KNOWLEDGE_TURN_NOT_OPERATOR` | Expected outside operator turns; ask from the terminal or the owner's DM |
| `KNOWLEDGE_DISABLED` | An org owner or admin enables Knowledge for the organization in the Console |

## Results are missing

```bash
ravi knowledge sources --json
ravi knowledge sources --failing --json
ravi knowledge why --last --json
```

- `local.lastIndexedAt` old: the daemon is not the leader or is down; the next terminal search indexes with a 1.5 s budget.
- `local.fts5: false`: SQLite lacks FTS5; search uses `LIKE` and is slower but correct.
- `issues` has `console_unavailable: <code>`: check `ravi login` and network; local results still work.

## Contact memory

```bash
ravi settings set knowledge.contactMemory.agents "support"
ravi settings set knowledge.project <project>
ravi doctor --json      # knowledge.f2_setup lists what is missing
ravi knowledge forget --about contact:<contact-id>
```

`knowledge.f2_setup` warns when the project, owner target, curator agent profile, codex parity or Console inbox subscription is missing.

## Local data

- Database: `~/.ravi/knowledge.db`. It can be deleted with the daemon stopped; the indexer rebuilds local history from `chat.db` and `~/.ravi/meetings/`. Contact items, forgotten subjects and gaps are lost with it.
- Retention runs once a day in the leader's index runner.

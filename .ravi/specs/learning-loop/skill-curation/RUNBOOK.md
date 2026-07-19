---
id: learning-loop/skill-curation
title: "Skill Curation Learning Loop — Runbook"
kind: capability
domain: learning-loop
status: draft
---

# Skill Curation Learning Loop / RUNBOOK

## Deploy A Runtime Change (mandatory ritual — I2 / deploy-reality)

```bash
bun run build && bun pm pack
npm install -g "$(pwd)/ravi.bot-<version>.tgz"     # NPM global = the daemon's pm_exec_path, NOT bun global
ravi daemon restart -m "<reason>"
# verify the fix is in the RUNNING bundle before trusting anything:
pid=$(ravi daemon status --json | jq -r '.ravi.pid')
tr '\0' '\n' < /proc/$pid/environ | grep pm_exec_path
grep -c "<distinctive-string-of-your-fix>" /home/ravi/.nvm/.../lib/node_modules/ravi.bot/dist/bundle/index.js
```

## Tune The Cadence

Interval overridable per env (mirror `RAVI_MEMORY_NUDGE_INTERVAL`): expose `RAVI_SKILL_NUDGE_INTERVAL` (default 10 tool-iterations with skills available). For fast pilot validation set it low (2–3), then restore to 10.

## Watch The Loop Live (durable phase + runtime log)

```bash
grep "ravi:skills:nudge" ~/.pm2/logs/ravi-error.log | grep -oE "turnCount=[0-9]+" | tail
# dispatch signal: a curador task with createdBy=runtime:skill-nudge
ravi tasks list --json | jq '.tasks[] | select(.createdBy=="runtime:skill-nudge")'
```

## Pilot (before fleet-wide)

Enroll ONE profile (e.g. `main` or `researcher`) for ~2 weeks. Measure: reviews/session, `Nothing to save.` vs update ratio, review latency, token cost, RM-rejected false positives. Keep `consolidate=false`.

## Slow Curator (maintenance)

Run inactivity-triggered (cron/trigger, ~7d + min-idle). It applies pure-function lifecycle transitions (active→stale→archive) and NEVER deletes. Consolidation stays opt-in per profile; dry-run it first in dev/staging before any prod run.

## If A Skill Write Is Blocked At Cap (staged HITL)

Same as the memory index-cap case: the guard stages an over-cap write for human consolidation (R7) rather than silently dropping. Resolve by consolidating the target SKILL.md / index, then let the next cycle proceed.

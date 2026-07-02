# Cron / CHECKS

## List Output Includes Target State

```bash
ravi cron list --json --limit 5
```

Expected:

- each item in `items[]` and `jobs[]` carries `targetResolution` fields;
- shell jobs without notification targets do not emit agent-missing.

## Doctor Cron Targets Check

```bash
ravi doctor --json | jq '.checks[] | select(.id == "cron.targets")'
```

Expected:

- check id is `cron.targets`;
- findings use stable ids (`cron.agent_missing`, etc.);
- evidence is bounded;
- fix hints are safe read-only commands.

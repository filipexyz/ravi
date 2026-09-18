# Cron / CHECKS

## List Output MUST Include Target State

```bash
ravi cron list --json --limit 5
```

- Each item in `items[]` and `jobs[]` MUST carry a `targetResolution` field. The check fails if the field is absent.
- Shell jobs without notification targets MUST NOT emit `agent_missing`. The check fails if they do.

## Doctor Cron Targets Check MUST Use Stable IDs

```bash
ravi doctor --json | jq '.checks[] | select(.id == "cron.targets")'
```

- The check id MUST be `cron.targets`. It fails if the check is missing.
- Findings MUST use stable ids (`cron.agent_missing`, `cron.reply_session_missing`, `cron.routing_derived_key`, `cron.routing_unresolved`). The check fails if an unexpected id appears.
- Evidence MUST be bounded (max 20 findings). The check fails if the findings array exceeds the cap.
- Fix hints MUST be safe read-only commands. The check fails if a fix hint suggests a destructive mutation.

## Cross-Agent Visibility MUST Follow Agent Grants

```bash
RAVI_CONTEXT_KEY=<viewer-ctx> ravi cron list --all-agents --json | jq '{visibility: .filters.visibility, owners: [.items[].agentId] | unique}'
```

- With no cross-agent grant, `owners` MUST contain only the caller's own agent id and `visibility` MUST be `scoped`. The check fails if another owner appears.
- With `view agent:<owner>` (or `view agent:*`), the owner's jobs MUST appear. Jobs with no `agentId` MUST appear only when the caller may view the default agent.
- With `modify agent:<owner>` but no `view`, the owner's jobs MUST NOT appear. The check fails if a write grant leaks read visibility.

## Denied Mutation MUST Say Permission Denied, Not Not-Found

```bash
RAVI_CONTEXT_KEY=<viewer-ctx> ravi cron disable <other-agent-job-id> --json
```

- For an existing job the caller may not modify, `error.code` MUST be `PERMISSION_DENIED` and the exit code MUST be 1. The check fails on `CRON_JOB_NOT_FOUND`.
- The envelope MUST NOT contain the job name, message, schedule, or shell command. It MUST NOT contain `agent:<owner>` unless the caller holds `view agent:<owner>`; when it does, `error.requiredCapability` MUST be `modify:agent:<owner>`.
- `error.denialId` MUST resolve through `ravi permissions resolve <denialId> --json` to a plan whose `missingCapability` is `modify:agent:<owner>`.
- The job MUST be unchanged afterwards (`cron show` from an authorized principal), and no `ravi.cron.refresh` MUST have been emitted.
- `cron show <other-agent-job-id>` without `view agent:<owner>` MUST still return `CRON_JOB_NOT_FOUND`.
- With `modify agent:<owner>` or `admin system:*`, the same `cron disable` MUST succeed with `status: "disabled"`.

## Cron Creation MUST Be Durably Idempotent

- Repeating `cron add` with the same explicit idempotency key and the same normalized input MUST return the original target with `changedCount=0`.
- Reusing an explicit key for different input MUST fail.
- Replaying the same observer rule/source-turn/action after a one-shot target was deleted MUST NOT recreate the cron.

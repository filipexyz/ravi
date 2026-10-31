# Cron / CHECKS

## Test State MUST Be Isolated

- Every cron database test MUST create and clean its own isolated Ravi state, including
  `cron-db.test.ts`; a process-level state directory alone is insufficient because
  cleanup in another test file can remove that override. Tests MUST NOT fall back
  to the operator installation.

## Invalid Ownership MUST Reconcile Without Executing

- `bun test src/cron/` MUST prove legacy agent-owned shell jobs, including distant
  and unscheduled jobs, disable at load without executing or updating run history.
- The same suite MUST prove a second cycle/reload/manual trigger emits no second
  notice, ownership changes after timer arming are checked, and a failed notice
  never re-enables the job. Operator shell and agent-owned agent jobs still run.
- `bun test src/cli/commands/cron-commands.test.ts` MUST distinguish invalid shell,
  operator shell and agent-owned agent jobs in JSON and text without mutating rows.

## Distant Jobs MUST NOT Overflow The Timer

- `bun test src/cron/runner.test.ts` MUST prove a job more than 2,147,483,647 ms
  away arms a capped timer, re-arms when checked early, and neither dispatches
  nor changes the persisted due time before the job is due.

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

## Admission Authority MUST Survive Job Mutation

- `bun test src/cron/runner.test.ts` MUST dispatch a contact job, classify its
  runtime context, transfer to the operator mid-turn, and still classify as the
  contact. The next dispatch MUST use the operator. Cover main and isolated
  sessions, queued consumption, continuations, and the reverse transfer.
- The same suite MUST refuse owner-attributed calls after the original contact
  is blocked or removed, even when the job has transferred to the operator.
- Disabling a job MUST preserve admitted authority while stopping subsequent
  scheduled dispatch. One-shot auto-deletion MUST preserve admitted authority.
- Shell execution MUST carry the captured authority after a transfer, overriding
  an env-file replacement. Missing or malformed prompt snapshots MUST refuse.
- `bun test src/runtime/runtime-request-context.test.ts` MUST retain the admitted
  contact/chat overlay when ownership changes before queued consumption.
- `bun test src/link/connector-turn.test.ts src/cloud-auth/turn-actor.test.ts`
  MUST prevent promotion through a later operator identity link and prevent a
  blocked operator-linked contact from falling back to contact/Console authority.

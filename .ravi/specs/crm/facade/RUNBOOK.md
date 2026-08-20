# CRM Agent-First Facade / RUNBOOK

## Use

Discover the current contracts before planning:

```bash
ravi specs get crm/facade --mode full --json
ravi crm help --json
ravi crm lifecycle show --json
```

Create a plan with an exact target and the operation-specific arguments:

```bash
ravi crm facade plan task.done <task-id> --json
ravi crm facade plan task.cancel <task-id> --reason <text> --json
ravi crm facade plan task.snooze <task-id> --until <iso-timestamp> --json
ravi crm facade plan opportunity.move <opportunity-id> --stage <stage> --json
ravi crm facade plan fact.confirm <fact-id> --json
ravi crm facade plan fact.reject <fact-id> --json
ravi crm facade plan contact.set <contact> --field <field> --value <value> --json
ravi crm facade plan account.link-contact <account-id> --contact <contact> --json
ravi crm facade plan opportunity.link-contact <opportunity-id> --contact <contact> --json
```

Review `planId`, `planHash`, the resolved target, normalized arguments, and
`expiresAt`. Planning changes no CRM business data.

From the Ravi conversation that requested the change, approve and apply once:

```bash
ravi crm facade approve <plan-id> --json
ravi crm facade apply <plan-id> --json
ravi crm facade verify <plan-id> --json
```

Do not add source or agent flags. Approval derives its destination and expected
sender from the active Ravi runtime context. The receipt enforces external
message id and sender id; stored thread metadata is not an end-to-end thread
authorization check.

## Debug

1. Run `ravi crm facade verify <plan-id> --json` and inspect the persisted state,
   expiry, outcome, and readback.
2. If approval returns `APPROVAL_CONTEXT_REQUIRED`, invoke it from a Ravi turn
   that supplies channel, account, chat, and sender identity. Do not manufacture
   those values as CLI arguments.
3. If the plan is expired or reports `PLAN_PRECONDITION_CHANGED`, read the CRM
   target again and create a new plan. An old approval never transfers to it.
4. If integrity validation fails, stop. Do not edit the plan or recompute its
   hash; investigate the state database and restore from a trusted backup if
   needed.
5. If approval is denied or times out, do not call `approve` again for the same
   plan. Its first request receipt remains bound. Review the intent and create a
   new plan only if a human explicitly authorizes a new attempt.
6. If application returns `partial`, compare the readback with the normalized
   plan arguments and reconcile the CRM record manually.
7. If the plan remains `applying` after a process exit, or application returns
   `unknown`, run:

```bash
ravi crm facade recover <plan-id> --json
```

Inspect the real CRM record and the `crm_facade_plans` and
`crm_facade_effects` rows in the configured CRM state database using read-only
access. A journal row marked `dispatched` is not proof that the mutation call
ran. Never apply the same plan again. Creating a fresh plan is an operational
decision after reconciliation; the current code does not prevent another plan
for the same business intent.

## Rollout

1. Merge only after the focused facade, CLI, approval, contract, SDK, build, and
   type gates pass.
2. Back up the configured CRM state database and deploy the approved Ravi build.
3. Verify spec retrieval, `ravi crm help --json`, lifecycle discovery, and
   read-only CRM commands before enabling effects.
4. In a controlled Ravi conversation, exercise one low-impact plan through
   approve, apply, and verify.
5. Migrate selected consumers to the facade operation by operation. Keep legacy
   commands available until each consumer has its own rollback evidence.
6. Treat any `partial` or `unknown` result as a rollout stop for that operation
   until manually reconciled.

## Rollback

1. Stop consumers from creating or applying new facade plans.
2. Manually inspect any `applying`, `partial`, or `unknown` plan; do not replay
   it during rollback.
3. Route migrated consumers back to their previous CRM command and restore the
   last approved Ravi build.
4. Re-run read-only CRM checks after restart.
5. Leave the additive facade plan and effect tables in place. They are inert
   when no consumer calls the facade and preserve audit evidence.

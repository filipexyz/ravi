# Session Followups / CHECKS

## Checks

- Creating a cadence MUST persist explicit steps and a next check time.
- Duplicate scheduled runs MUST NOT publish duplicate prompts.
- Due followup prompts MUST use `deliveryBarrier=after_response`.
- Chat cadences MUST resolve the active attached session for that chat.
- Progressive steps MUST fire one at a time and reset on new external chat
  activity.
- A chat/list target with no attached session MUST record a skipped run.
- `ravi sessions followups list --json` MUST return pagination-ready state.
- `bun test src/session-followups/db.test.ts src/session-followups/service.test.ts src/cli/commands/session-followups.test.ts`
  SHOULD pass after changing followup behavior.

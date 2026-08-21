#!/usr/bin/env bash
set -euo pipefail

cli_path="${1:?usage: run-e2e.sh <ravi-cli> <state-dir>}"
state_dir="${2:?usage: run-e2e.sh <ravi-cli> <state-dir>}"

export RAVI_STATE_DIR="$state_dir"
export RAVI_AGENT_ID="crm-inc1-e2e"
export RAVI_CHANNEL="cli"
export RAVI_ACCOUNT_ID="ravi"
export RAVI_CHAT_ID="crm-inc1-e2e"

assert_not_found() {
  local expected_code="$1"
  shift
  local output
  local exit_code

  set +e
  output=$("$cli_path" "$@" --json)
  exit_code=$?
  set -e

  test "$exit_code" -eq 1
  jq -e --arg code "$expected_code" '
    .success == false and
    .error.code == $code and
    .error.retryable == false and
    (.error.suggestedAction | type == "string" and length > 0)
  ' <<<"$output" >/dev/null

  if [ "$expected_code" = "OPPORTUNITY_NOT_FOUND" ]; then
    jq -e '.error | has("suggestions") | not' <<<"$output" >/dev/null
  fi
}

assert_not_found "CRM_FACT_NOT_FOUND" crm fact confirm crm_fact_inc1_missing
assert_not_found "CRM_TASK_NOT_FOUND" crm task done crm_task_inc1_missing
assert_not_found "OPPORTUNITY_NOT_FOUND" crm opportunity move crm_opp_inc1_missing qualified

account_json=$("$cli_path" crm account create "INC-1 E2E Fixture" \
  --idempotency-key crm-inc1-e2e-account --json)
account_id=$(jq -er '.account.id' <<<"$account_json")

task_json=$("$cli_path" crm task create "INC-1 E2E task" \
  --account "$account_id" \
  --idempotency-key crm-inc1-e2e-task \
  --json)
task_id=$(jq -er '.task.id' <<<"$task_json")

done_json=$("$cli_path" crm task done "$task_id" --json)
jq -e '.status == "done" and .task.status == "done"' <<<"$done_json" >/dev/null

readback_json=$("$cli_path" crm task show "$task_id" --json)
jq -e --arg task_id "$task_id" '.target == $task_id and .task.status == "done"' <<<"$readback_json" >/dev/null

jq -n \
  --arg account_id "$account_id" \
  --arg task_id "$task_id" \
  '{success:true, st12:"PASS", st13:"PASS", st14:"PASS", happyPath:"PASS", readback:"PASS", accountId:$account_id, taskId:$task_id}'

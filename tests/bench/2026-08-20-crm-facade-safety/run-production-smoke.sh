#!/usr/bin/env bash
set -euo pipefail

cli_path="${1:?usage: run-production-smoke.sh <ravi-cli> <state-dir>}"
state_dir="${2:?usage: run-production-smoke.sh <ravi-cli> <state-dir>}"

export RAVI_STATE_DIR="$state_dir"
export RAVI_AGENT_ID="crm-facade-production-smoke"
export RAVI_CHANNEL="cli"
export RAVI_ACCOUNT_ID="ravi"
export RAVI_CHAT_ID="crm-facade-production-smoke"

account_json=$("$cli_path" crm account create "CRM facade smoke fixture" \
  --idempotency-key crm-facade-production-smoke-account --json)
account_id=$(jq -er '.account.id' <<<"$account_json")

task_json=$("$cli_path" crm task create "CRM facade smoke task" \
  --account "$account_id" \
  --idempotency-key crm-facade-production-smoke-task \
  --json)
task_id=$(jq -er '.task.id' <<<"$task_json")

plan_json=$("$cli_path" crm facade plan task.done "$task_id" --json)
plan_id=$(jq -er '.planId' <<<"$plan_json")
jq -e --arg task_id "$task_id" '
  .state == "planned" and
  .operation == "task.done" and
  .target.id == $task_id
' <<<"$plan_json" >/dev/null

verify_json=$("$cli_path" crm facade verify "$plan_id" --json)
jq -e --arg task_id "$task_id" '
  .state == "planned" and
  .outcome == "not_applied" and
  .readback.id == $task_id and
  .readback.status == "open" and
  (.readback | has("contacts") | not) and
  (.readback | has("opportunities") | not)
' <<<"$verify_json" >/dev/null

recover_json=$("$cli_path" crm facade recover "$plan_id" --json)
jq -e '
  .outcome == "not_applied" and
  .action == "manual_review_required" and
  .replay == false
' <<<"$recover_json" >/dev/null

jq -n \
  --arg account_id "$account_id" \
  --arg task_id "$task_id" \
  --arg plan_id "$plan_id" \
  '{success:true, plan:"PASS", verify:"PASS", recover:"PASS", minimalReadback:"PASS", accountId:$account_id, taskId:$task_id, planId:$plan_id}'


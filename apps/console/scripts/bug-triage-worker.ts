#!/usr/bin/env bun

import { runBugTriageJobs } from "@/server/console/bug-triage-jobs";
import { isBugTriageEngineConfigured } from "@/server/console/bug-triage-config";

if (!isBugTriageEngineConfigured()) {
  console.log(
    JSON.stringify({
      status: "blocked",
      code: "triage_engine_not_configured",
    }),
  );
  process.exit(2);
}

const limit = boundedLimit(process.env.RAVI_BUG_TRIAGE_WORKER_LIMIT);
const result = await runBugTriageJobs({ limit });
console.log(JSON.stringify({ status: "ok", result }));

function boundedLimit(value: string | undefined) {
  const parsed = value ? Number(value) : 5;
  if (!Number.isInteger(parsed) || parsed < 1) return 5;
  return Math.min(parsed, 25);
}

#!/usr/bin/env bun

import { publishAgentInboxOutboxBatch } from "@/server/console/agent-inbox";
import { createAgentInboxNatsCliPublisherFromEnv } from "@/server/console/agent-inbox-event-plane";

const publisher = createAgentInboxNatsCliPublisherFromEnv();
if (!publisher) {
  console.log(JSON.stringify({
    status: "blocked",
    code: "agent_inbox_event_plane_config_missing",
  }));
  process.exit(2);
}

const limit = boundedLimit(process.env.RAVI_AGENT_INBOX_OUTBOX_LIMIT);
const result = await publishAgentInboxOutboxBatch({ publisher, limit });
console.log(JSON.stringify({ status: "ok", result }));

function boundedLimit(value: string | undefined) {
  const parsed = value ? Number(value) : 25;
  if (!Number.isInteger(parsed) || parsed < 1) return 25;
  return Math.min(parsed, 100);
}

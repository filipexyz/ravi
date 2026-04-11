import type { CronJob } from "../cron/index.js";
import { formatInspectionMeta, formatInspectionSection } from "./inspection-output.js";

const CRON_DB_META = { source: "cron-db", freshness: "persisted" } as const;
const CRON_RUNTIME_META = { source: "runtime-snapshot", freshness: "persisted", via: "cron-runner" } as const;
const CRON_SCHEDULE_META = { source: "derived", freshness: "derived-now", via: "cron-db" } as const;
const CRON_EXECUTION_META = { source: "derived", freshness: "derived-now", via: "cron-db" } as const;
const CRON_ROUTING_META = { source: "resolver", freshness: "derived-now", via: "reply-session" } as const;

export type CronRoutingSource = {
  channel: string;
  accountId: string;
  chatId: string;
  threadId?: string;
};

export type CronRoutingResolution =
  | {
      kind: "resolved-session";
      replySession: string;
      sessionName: string;
      source?: CronRoutingSource;
    }
  | {
      kind: "derived-key";
      replySession: string;
      source?: CronRoutingSource;
    }
  | {
      kind: "none";
    };

function formatCronRoutingSource(source: CronRoutingSource): string {
  const account = source.accountId || "(unset account)";
  const thread = source.threadId ? ` (thread ${source.threadId})` : "";
  return `${source.channel}/${account} -> ${source.chatId}${thread}`;
}

function fieldLine(
  label: string,
  value: unknown,
  meta: Parameters<typeof formatInspectionMeta>[0],
  labelWidth = 16,
): string {
  return `  ${`${label}:`.padEnd(labelWidth)}${value}  ${formatInspectionMeta(meta)}`;
}

function blockLines(
  label: string,
  meta: Parameters<typeof formatInspectionMeta>[0],
  lines: string | string[],
  labelWidth = 16,
): string[] {
  return [
    `  ${`${label}:`.padEnd(labelWidth)}${formatInspectionMeta(meta)}`,
    ...(Array.isArray(lines) ? lines : [lines]).map((line) => `    ${line}`),
  ];
}

function buildCronExecutionLines(job: CronJob, agentId: string, routing: CronRoutingResolution): string[] {
  const lines = [
    `agent \`${agentId}\` receives the prompt${job.agentId ? "" : " (resolved from the runtime default agent)"}.`,
  ];

  if (job.sessionTarget === "main") {
    if (routing.kind === "resolved-session") {
      lines.push(
        `\`sessionTarget=main\` plus a live \`replySession\` means execution is published into existing session \`${routing.sessionName}\` instead of the agent main session.`,
      );
    } else {
      lines.push("`sessionTarget=main` uses the agent's shared main session.");
      if (routing.kind === "derived-key") {
        lines.push(
          "The configured `replySession` did not resolve to a live session, so execution stays in agent main.",
        );
      }
    }
  } else {
    lines.push(
      `\`sessionTarget=isolated\` always runs in the dedicated cron session \`agent:${agentId}:cron:${job.id}\`.`,
    );
    if (routing.kind !== "none") {
      lines.push("`replySession` does not change the execution session in isolated mode; it only seeds reply routing.");
    }
  }

  return lines;
}

function buildCronRoutingLines(job: CronJob, routing: CronRoutingResolution): string[] {
  const lines: string[] = [];

  if (routing.kind === "resolved-session") {
    lines.push(
      `\`replySession\` is set to \`${routing.replySession}\` and currently resolves to session \`${routing.sessionName}\`.`,
    );
    if (routing.source) {
      lines.push(
        `Routing source comes from that session's last saved source: ${formatCronRoutingSource(routing.source)}.`,
      );
    } else {
      lines.push("That session has no saved channel/chat yet, so it does not pin an outbound target by itself.");
    }
  } else if (routing.kind === "derived-key") {
    lines.push(
      `\`replySession\` is set to \`${routing.replySession}\`, but it does not resolve to a live session right now.`,
    );
    if (routing.source) {
      lines.push(
        `Runner falls back to deriving routing from the session key: ${formatCronRoutingSource(routing.source)}.`,
      );
    } else {
      lines.push("Runner cannot derive channel/chat from that value, so it does not pin an outbound target by itself.");
    }
  } else {
    lines.push(
      "No `replySession` is pinned; replies depend on whatever source is already attached to the execution session.",
    );
  }

  if (job.accountId) {
    lines.push(
      `Instance/account override is explicitly set to \`${job.accountId}\`; it replaces the source account when a routing source exists, but it does not create routing on its own.`,
    );
  } else {
    lines.push(
      "No explicit instance/account override is set; the account comes from the resolved routing source when one exists.",
    );
  }

  if (
    routing.kind === "none" ||
    (routing.kind === "resolved-session" && !routing.source) ||
    (routing.kind === "derived-key" && !routing.source)
  ) {
    lines.push(
      "If no source is available at execution time, the prompt still runs, but outbound delivery is not explicitly targeted.",
    );
  }

  return lines;
}

export function buildCronShowOutput(
  job: CronJob,
  scheduleDescription: string,
  agentId: string,
  routing: CronRoutingResolution,
): string[] {
  const lines = [`\nCron Job: ${job.name}\n`];

  lines.push(fieldLine("ID", job.id, CRON_DB_META));
  lines.push(fieldLine("Agent", job.agentId ?? "(default)", CRON_DB_META));
  lines.push(fieldLine("Account", job.accountId ?? "(auto)", CRON_DB_META));
  lines.push(fieldLine("Enabled", job.enabled ? "yes" : "no", CRON_DB_META));
  lines.push(fieldLine("Schedule", scheduleDescription, CRON_SCHEDULE_META));
  lines.push(fieldLine("Session", job.sessionTarget, CRON_DB_META));
  if (job.replySession) {
    lines.push(fieldLine("Reply session", job.replySession, CRON_DB_META));
  }
  if (job.description) {
    lines.push(fieldLine("Description", job.description, CRON_DB_META));
  }
  lines.push(fieldLine("Delete after", job.deleteAfterRun ? "yes" : "no", CRON_DB_META));
  lines.push("");
  lines.push(formatInspectionSection("  Execution:", CRON_EXECUTION_META));
  for (const line of buildCronExecutionLines(job, agentId, routing)) {
    lines.push(`    - ${line}`);
  }
  lines.push("");
  lines.push(formatInspectionSection("  Routing:", CRON_ROUTING_META));
  for (const line of buildCronRoutingLines(job, routing)) {
    lines.push(`    - ${line}`);
  }
  lines.push("");
  lines.push(...blockLines("Message", CRON_DB_META, job.message.split("\n")));
  lines.push("");
  if (job.nextRunAt) {
    lines.push(fieldLine("Next run", new Date(job.nextRunAt).toLocaleString(), CRON_RUNTIME_META));
  }
  if (job.lastRunAt) {
    lines.push(fieldLine("Last run", new Date(job.lastRunAt).toLocaleString(), CRON_RUNTIME_META));
    lines.push(fieldLine("Last status", job.lastStatus ?? "-", CRON_RUNTIME_META));
    if (job.lastDurationMs !== undefined) {
      lines.push(fieldLine("Last duration", `${job.lastDurationMs}ms`, CRON_RUNTIME_META));
    }
    if (job.lastError) {
      lines.push(fieldLine("Last error", job.lastError, CRON_RUNTIME_META));
    }
  }
  lines.push(fieldLine("Created", new Date(job.createdAt).toLocaleString(), CRON_DB_META));

  return lines;
}

/**
 * Outbound Commands - Outbound queue management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { notif } from "../../notif.js";
import { getAgent } from "../../router/config.js";
import { getDefaultTimezone, getDefaultAgentId, getDb } from "../../router/router-db.js";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizePhone, formatPhone, findContactsByTag } from "../../contacts.js";
import { parseDurationMs, formatDurationMs } from "../../cron/index.js";
import {
  dbCreateQueue,
  dbGetQueue,
  dbListQueues,
  dbUpdateQueue,
  dbDeleteQueue,
  dbUpdateQueueState,
  dbAddEntry,
  dbGetEntry,
  dbListEntries,
  dbDeleteEntry,
  dbUpdateEntry,
  dbMarkEntryDone,
  dbUpdateEntryContext,
  dbAddEntriesFromContacts,
  directSend,
} from "../../outbound/index.js";

function statusColor(status: string): string {
  switch (status) {
    case "active": return "\x1b[32m";
    case "paused": return "\x1b[33m";
    case "completed": return "\x1b[36m";
    case "pending": return "\x1b[37m";
    case "done": return "\x1b[32m";
    case "agent": return "\x1b[35m";
    case "skipped": return "\x1b[90m";
    case "error": return "\x1b[31m";
    default: return "\x1b[0m";
  }
}

const RESET = "\x1b[0m";

@Group({
  name: "outbound",
  description: "Outbound queue management",
})
export class OutboundCommands {
  // ========================================================================
  // Queue commands
  // ========================================================================

  @Command({ name: "create", description: "Create a new outbound queue" })
  async create(
    @Arg("name", { description: "Queue name" }) name: string,
    @Option({ flags: "--instructions <text>", description: "Agent instructions for processing entries" }) instructions?: string,
    @Option({ flags: "--every <interval>", description: "Interval between entries (e.g., 5m, 1h)" }) every?: string,
    @Option({ flags: "--agent <id>", description: "Agent ID (default: default agent)" }) agent?: string,
    @Option({ flags: "--description <text>", description: "Queue description" }) description?: string,
    @Option({ flags: "--active-start <time>", description: "Active hours start (e.g., 09:00)" }) activeStart?: string,
    @Option({ flags: "--active-end <time>", description: "Active hours end (e.g., 22:00)" }) activeEnd?: string,
    @Option({ flags: "--tz <timezone>", description: "Timezone" }) tz?: string,
    @Option({ flags: "--follow-up <json>", description: 'Follow-up delays per qualification in minutes, e.g. \'{"cold":120,"warm":30}\'' }) followUpJson?: string,
    @Option({ flags: "--max-rounds <n>", description: "Maximum rounds per entry" }) maxRoundsStr?: string,
  ) {
    if (!instructions) {
      fail("--instructions is required");
    }
    if (!every) {
      fail("--every is required");
    }

    const intervalMs = parseDurationMs(every);

    if (agent) {
      const ag = getAgent(agent);
      if (!ag) fail(`Agent not found: ${agent}`);
    }

    const timezone = tz ?? getDefaultTimezone();

    let followUp: Record<string, number> | undefined;
    if (followUpJson) {
      try {
        followUp = JSON.parse(followUpJson);
      } catch {
        fail("Invalid --follow-up JSON");
      }
    }

    const maxRounds = maxRoundsStr ? parseInt(maxRoundsStr, 10) : undefined;

    try {
      const queue = dbCreateQueue({
        name,
        instructions,
        intervalMs,
        agentId: agent,
        description,
        activeStart,
        activeEnd,
        timezone,
        followUp,
        maxRounds,
      });

      console.log(`\n✓ Created queue: ${queue.id}`);
      console.log(`  Name:      ${queue.name}`);
      console.log(`  Interval:  ${formatDurationMs(queue.intervalMs)}`);
      console.log(`  Status:    paused`);
      console.log(`\nAdd entries:`);
      console.log(`  ravi outbound add ${queue.id} <phone> --name "João Silva"`);
      console.log(`  ravi outbound add ${queue.id} <phone> --name "Maria" --context '{"company":"Acme","role":"CTO"}'`);
      console.log(`\nStart: ravi outbound start ${queue.id}`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "list", description: "List all outbound queues" })
  list() {
    const queues = dbListQueues();

    if (queues.length === 0) {
      console.log("\nNo outbound queues configured.\n");
      console.log("Usage:");
      console.log('  ravi outbound create "Prospecção" --instructions "..." --every 5m');
      return;
    }

    console.log("\nOutbound Queues:\n");
    console.log("  ID        NAME                      STATUS     INTERVAL   PROCESSED  NEXT RUN");
    console.log("  --------  ------------------------  ---------  ---------  ---------  --------------------");

    for (const queue of queues) {
      const id = queue.id.padEnd(8);
      const name = queue.name.slice(0, 24).padEnd(24);
      const status = `${statusColor(queue.status)}${queue.status.padEnd(9)}${RESET}`;
      const interval = formatDurationMs(queue.intervalMs).padEnd(9);
      const processed = String(queue.totalProcessed).padEnd(9);
      const nextRun = queue.nextRunAt
        ? new Date(queue.nextRunAt).toLocaleString()
        : "-";

      console.log(`  ${id}  ${name}  ${status}  ${interval}  ${processed}  ${nextRun}`);
    }

    console.log(`\n  Total: ${queues.length} queues`);
  }

  @Command({ name: "show", description: "Show queue details" })
  show(@Arg("id", { description: "Queue ID" }) id: string) {
    const queue = dbGetQueue(id);
    if (!queue) fail(`Queue not found: ${id}`);

    const entries = dbListEntries(id);
    const pending = entries.filter(e => e.status === "pending" || e.status === "active").length;
    const done = entries.filter(e => e.status === "done").length;

    console.log(`\nOutbound Queue: ${queue.name}\n`);
    console.log(`  ID:           ${queue.id}`);
    console.log(`  Agent:        ${queue.agentId ?? "(default)"}`);
    console.log(`  Status:       ${statusColor(queue.status)}${queue.status}${RESET}`);
    console.log(`  Interval:     ${formatDurationMs(queue.intervalMs)}`);

    if (queue.description) {
      console.log(`  Description:  ${queue.description}`);
    }
    if (queue.activeStart && queue.activeEnd) {
      console.log(`  Active hours: ${queue.activeStart} - ${queue.activeEnd}`);
    }
    if (queue.timezone) {
      console.log(`  Timezone:     ${queue.timezone}`);
    }
    if (queue.followUp) {
      console.log(`  Follow-up:    ${JSON.stringify(queue.followUp)}`);
    }
    if (queue.maxRounds !== undefined) {
      console.log(`  Max rounds:   ${queue.maxRounds}`);
    }

    console.log("");
    console.log(`  Instructions:`);
    console.log(`    ${queue.instructions.split("\n").join("\n    ")}`);
    console.log("");

    console.log(`  Entries:      ${entries.length} total (${pending} pending, ${done} done)`);
    console.log(`  Processed:    ${queue.totalProcessed}`);
    console.log(`  Sent:         ${queue.totalSent}`);
    console.log(`  Skipped:      ${queue.totalSkipped}`);

    if (queue.nextRunAt) {
      console.log(`  Next run:     ${new Date(queue.nextRunAt).toLocaleString()}`);
    }
    if (queue.lastRunAt) {
      console.log(`  Last run:     ${new Date(queue.lastRunAt).toLocaleString()}`);
      console.log(`  Last status:  ${queue.lastStatus ?? "-"}`);
      if (queue.lastError) {
        console.log(`  Last error:   ${queue.lastError}`);
      }
    }

    console.log(`  Created:      ${new Date(queue.createdAt).toLocaleString()}`);
  }

  @Command({ name: "start", description: "Start (activate) a queue" })
  async start(@Arg("id", { description: "Queue ID" }) id: string) {
    const queue = dbGetQueue(id);
    if (!queue) fail(`Queue not found: ${id}`);

    const entries = dbListEntries(id);
    const pending = entries.filter(e => e.status === "pending" || e.status === "active").length;
    if (pending === 0) {
      fail(`Queue has no pending entries. Add entries first: ravi outbound add ${id} <phone>`);
    }

    // Set status to active and schedule first run
    dbUpdateQueue(id, { status: "active" });
    dbUpdateQueueState(id, {
      lastRunAt: Date.now(),
      lastStatus: "started",
      nextRunAt: Date.now() + 1000, // Run almost immediately
    });

    await notif.emit("ravi.outbound.refresh", {});

    console.log(`✓ Queue started: ${id} (${queue.name})`);
    console.log(`  ${pending} entries pending`);
    console.log(`  Interval: ${formatDurationMs(queue.intervalMs)}`);
  }

  @Command({ name: "pause", description: "Pause a queue" })
  async pause(@Arg("id", { description: "Queue ID" }) id: string) {
    const queue = dbGetQueue(id);
    if (!queue) fail(`Queue not found: ${id}`);

    dbUpdateQueue(id, { status: "paused" });
    await notif.emit("ravi.outbound.refresh", {});

    console.log(`✓ Queue paused: ${id} (${queue.name})`);
  }

  @Command({ name: "set", description: "Set queue property" })
  async set(
    @Arg("id", { description: "Queue ID" }) id: string,
    @Arg("key", { description: "Property: name, instructions, every, agent, description, active-start, active-end, tz" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const queue = dbGetQueue(id);
    if (!queue) fail(`Queue not found: ${id}`);

    try {
      switch (key) {
        case "name":
          dbUpdateQueue(id, { name: value });
          console.log(`✓ Name set: ${id} -> ${value}`);
          break;

        case "instructions":
          dbUpdateQueue(id, { instructions: value });
          console.log(`✓ Instructions set: ${id}`);
          break;

        case "every":
        case "interval": {
          const ms = parseDurationMs(value);
          dbUpdateQueue(id, { intervalMs: ms });
          console.log(`✓ Interval set: ${id} -> ${formatDurationMs(ms)}`);
          break;
        }

        case "agent": {
          const agentId = value === "null" || value === "-" ? undefined : value;
          if (agentId) {
            const ag = getAgent(agentId);
            if (!ag) fail(`Agent not found: ${agentId}`);
          }
          dbUpdateQueue(id, { agentId });
          console.log(`✓ Agent set: ${id} -> ${agentId ?? "(default)"}`);
          break;
        }

        case "description":
          dbUpdateQueue(id, { description: value === "null" || value === "-" ? undefined : value });
          console.log(`✓ Description set: ${id}`);
          break;

        case "active-start":
          dbUpdateQueue(id, { activeStart: value === "null" || value === "-" ? undefined : value });
          console.log(`✓ Active start set: ${id} -> ${value}`);
          break;

        case "active-end":
          dbUpdateQueue(id, { activeEnd: value === "null" || value === "-" ? undefined : value });
          console.log(`✓ Active end set: ${id} -> ${value}`);
          break;

        case "tz":
        case "timezone":
          dbUpdateQueue(id, { timezone: value === "null" || value === "-" ? undefined : value });
          console.log(`✓ Timezone set: ${id} -> ${value}`);
          break;

        case "follow-up":
        case "followUp": {
          if (value === "null" || value === "-") {
            dbUpdateQueue(id, { followUp: undefined });
            console.log(`✓ Follow-up disabled: ${id}`);
          } else {
            try {
              const parsed = JSON.parse(value);
              dbUpdateQueue(id, { followUp: parsed });
              console.log(`✓ Follow-up set: ${id} -> ${JSON.stringify(parsed)}`);
            } catch {
              fail("Invalid JSON for follow-up");
            }
          }
          break;
        }

        case "max-rounds":
        case "maxRounds": {
          if (value === "null" || value === "-") {
            dbUpdateQueue(id, { maxRounds: undefined });
            console.log(`✓ Max rounds cleared: ${id}`);
          } else {
            const n = parseInt(value, 10);
            if (isNaN(n) || n < 1) fail("max-rounds must be a positive integer");
            dbUpdateQueue(id, { maxRounds: n });
            console.log(`✓ Max rounds set: ${id} -> ${n}`);
          }
          break;
        }

        default:
          fail(`Unknown property: ${key}. Valid: name, instructions, every, agent, description, active-start, active-end, tz, follow-up, max-rounds`);
      }

      await notif.emit("ravi.outbound.refresh", {});
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "rm", description: "Delete a queue", aliases: ["delete", "remove"] })
  async rm(@Arg("id", { description: "Queue ID" }) id: string) {
    const queue = dbGetQueue(id);
    if (!queue) fail(`Queue not found: ${id}`);

    dbDeleteQueue(id);
    await notif.emit("ravi.outbound.refresh", {});

    console.log(`✓ Deleted queue: ${id} (${queue.name})`);
  }

  // ========================================================================
  // Entry commands
  // ========================================================================

  @Command({ name: "add", description: "Add entry to a queue" })
  add(
    @Arg("queueId", { description: "Queue ID" }) queueId: string,
    @Arg("phone", { description: "Phone number" }) phone: string,
    @Option({ flags: "--name <name>", description: "Contact name (required)" }) name?: string,
    @Option({ flags: "--email <email>", description: "Contact email" }) email?: string,
    @Option({ flags: "--tag <tag>", description: "Add all contacts with this tag" }) tag?: string,
    @Option({ flags: "--context <json>", description: "Extra context as JSON (e.g., '{\"company\":\"Acme\"}')" }) contextJson?: string,
  ) {
    const queue = dbGetQueue(queueId);
    if (!queue) fail(`Queue not found: ${queueId}`);

    if (tag) {
      // Add all contacts with the tag
      const contacts = findContactsByTag(tag);
      if (contacts.length === 0) {
        fail(`No contacts found with tag: ${tag}`);
      }

      const added = dbAddEntriesFromContacts(queueId, contacts);
      console.log(`✓ Added ${added} entries from tag "${tag}" (${contacts.length} contacts found)`);
      return;
    }

    const normalized = normalizePhone(phone);

    // Build context with name + any extra JSON
    const context: Record<string, unknown> = {};
    if (name) context.name = name;
    if (contextJson) {
      try {
        const extra = JSON.parse(contextJson);
        Object.assign(context, extra);
      } catch {
        fail("Invalid --context JSON");
      }
    }

    try {
      const entry = dbAddEntry({
        queueId,
        contactPhone: normalized,
        contactEmail: email,
        context,
      });

      console.log(`✓ Added entry: ${entry.id}`);
      console.log(`  Phone:    ${formatPhone(normalized)}`);
      if (name) console.log(`  Name:     ${name}`);
      console.log(`  Position: ${entry.position}`);
      if (Object.keys(context).length > (name ? 1 : 0)) {
        console.log(`  Context:  ${JSON.stringify(context)}`);
      }

      // Hint about missing info
      if (!name || !contextJson) {
        console.log("");
        if (!name) {
          console.log(`  Warning: no name. Add with:`);
          console.log(`    ravi outbound context ${entry.id} '{"name":"Contact Name"}'`);
        }
        if (!contextJson) {
          console.log(`  Tip: add context so the agent can personalize the approach:`);
          console.log(`    ravi outbound context ${entry.id} '{"company":"Acme","role":"CTO"}'`);
        }
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "entries", description: "List entries in a queue" })
  entries(@Arg("queueId", { description: "Queue ID" }) queueId: string) {
    const queue = dbGetQueue(queueId);
    if (!queue) fail(`Queue not found: ${queueId}`);

    const entries = dbListEntries(queueId);

    if (entries.length === 0) {
      console.log(`\nNo entries in queue "${queue.name}".`);
      console.log(`\nAdd: ravi outbound add ${queueId} <phone>`);
      return;
    }

    console.log(`\nEntries for "${queue.name}":\n`);
    console.log("  ID        POS  PHONE                  NAME                 STATUS    QUAL        ROUNDS  LAST RESPONSE");
    console.log("  --------  ---  --------------------   -------------------  --------  ----------  ------  ----------------");

    for (const entry of entries) {
      const id = entry.id.padEnd(8);
      const pos = String(entry.position).padEnd(3);
      const phone = formatPhone(entry.contactPhone).padEnd(20);
      const entryName = ((entry.context.name as string) ?? "-").slice(0, 19).padEnd(19);
      const status = `${statusColor(entry.status)}${entry.status.padEnd(8)}${RESET}`;
      const qual = (entry.qualification ?? "-").padEnd(10);
      const rounds = String(entry.roundsCompleted).padEnd(6);
      const lastResp = entry.lastResponseText
        ? entry.lastResponseText.slice(0, 16) + (entry.lastResponseText.length > 16 ? "..." : "")
        : "-";

      console.log(`  ${id}  ${pos}  ${phone}   ${entryName}  ${status}  ${qual}  ${rounds}  ${lastResp}`);
    }

    console.log(`\n  Total: ${entries.length} entries`);
  }

  @Command({ name: "status", description: "Show entry details" })
  status(@Arg("id", { description: "Entry ID" }) id: string) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    const queue = dbGetQueue(entry.queueId);

    console.log(`\nOutbound Entry: ${id}\n`);
    console.log(`  Queue:          ${queue?.name ?? entry.queueId}`);
    console.log(`  Phone:          ${formatPhone(entry.contactPhone)}`);
    if (entry.context.name) console.log(`  Name:           ${entry.context.name}`);
    if (entry.contactEmail) console.log(`  Email:          ${entry.contactEmail}`);
    console.log(`  Position:       ${entry.position}`);
    console.log(`  Status:         ${statusColor(entry.status)}${entry.status}${RESET}`);
    console.log(`  Qualification:  ${entry.qualification ?? "-"}`);
    console.log(`  Rounds:         ${entry.roundsCompleted}`);

    if (Object.keys(entry.context).length > 0) {
      console.log(`  Context:        ${JSON.stringify(entry.context)}`);
    }

    if (entry.lastProcessedAt) console.log(`  Last processed: ${new Date(entry.lastProcessedAt).toLocaleString()}`);
    if (entry.lastSentAt) console.log(`  Last sent:      ${new Date(entry.lastSentAt).toLocaleString()}`);
    if (entry.lastResponseAt) console.log(`  Last response:  ${new Date(entry.lastResponseAt).toLocaleString()}`);
    if (entry.lastResponseText) {
      console.log(`  Response text:`);
      console.log(`    ${entry.lastResponseText.split("\n").join("\n    ")}`);
    }

    console.log(`  Created:        ${new Date(entry.createdAt).toLocaleString()}`);
  }

  @Command({ name: "report", description: "Full outbound report with all entries and context" })
  report(@Arg("queueId", { description: "Queue ID (optional, all queues if omitted)", required: false }) queueId?: string) {
    const queues = queueId ? [dbGetQueue(queueId)].filter(Boolean) as import("../outbound/types.js").OutboundQueue[] : dbListQueues();

    if (queues.length === 0) {
      console.log("No queues found.");
      return;
    }

    for (const queue of queues) {
      const entries = dbListEntries(queue.id);
      console.log(`# ${queue.name} (${queue.status})`);
      console.log(`Interval: ${formatDurationMs(queue.intervalMs)} | Agent: ${queue.agentId}`);
      if (queue.followUp) console.log(`Follow-up: ${JSON.stringify(queue.followUp)} | Max rounds: ${queue.maxRounds ?? "-"}`);
      console.log(`Entries: ${entries.length}\n`);

      for (const entry of entries) {
        const name = (entry.context.name as string) ?? "-";
        console.log(`## ${name} (${formatPhone(entry.contactPhone)})`);
        console.log(`ID: ${entry.id} | Status: ${entry.status} | Qual: ${entry.qualification ?? "-"} | Rounds: ${entry.roundsCompleted}`);

        const { name: _n, ...ctx } = entry.context;
        if (Object.keys(ctx).length > 0) {
          console.log(`Context: ${JSON.stringify(ctx)}`);
        }

        if (entry.lastResponseText) {
          console.log(`Last response: ${entry.lastResponseText}`);
        }
        if (entry.lastResponseAt) {
          console.log(`Last response at: ${new Date(entry.lastResponseAt).toLocaleString()}`);
        }
        if (entry.lastSentAt) {
          console.log(`Last sent at: ${new Date(entry.lastSentAt).toLocaleString()}`);
        }
        console.log("");
      }
    }
  }

  @Command({ name: "chat", description: "Show chat history for an outbound entry" })
  chat(
    @Arg("id", { description: "Entry ID" }) id: string,
    @Option({ flags: "--limit <n>", description: "Number of messages (default: all)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Skip first N messages" }) offset?: string,
  ) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    const queue = dbGetQueue(entry.queueId);
    const agentId = queue?.agentId ?? "filipe";
    const sessionId = `agent:${agentId}:outbound:${queue?.id}:${entry.contactPhone}`;

    const { getHistory } = require("../../db.js") as typeof import("../../db.js");
    let messages = getHistory(sessionId);

    const off = offset ? parseInt(offset, 10) : 0;
    const lim = limit ? parseInt(limit, 10) : undefined;

    if (off > 0) messages = messages.slice(off);
    if (lim) messages = messages.slice(0, lim);

    const name = (entry.context.name as string) ?? formatPhone(entry.contactPhone);
    console.log(`\nChat: ${name} (${formatPhone(entry.contactPhone)})`);
    console.log(`Session: ${sessionId}`);
    console.log(`Messages: ${messages.length}${off ? ` (offset: ${off})` : ""}${lim ? ` (limit: ${lim})` : ""}\n`);

    for (const msg of messages) {
      const time = new Date(msg.created_at + "Z").toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      });
      const role = msg.role === "user" ? "SYSTEM" : "AGENT";
      console.log(`[${time}] ${role}:`);
      console.log(`${msg.content}\n`);
    }
  }

  // ========================================================================
  // Agent tool commands (used within outbound sessions)
  // ========================================================================

  @Command({ name: "send", description: "Send a message to an outbound entry's contact" })
  async send(
    @Arg("entryId", { description: "Entry ID" }) entryId: string,
    @Arg("message", { description: "Message text" }) message: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--typing-delay <ms>", description: "Typing indicator delay in ms before sending" }) typingDelay?: string,
    @Option({ flags: "--pause <ms>", description: "Pause in ms before typing (simulates reading/thinking)" }) pause?: string,
  ) {
    const entry = dbGetEntry(entryId);
    if (!entry) fail(`Entry not found: ${entryId}`);

    const result = await directSend({
      to: entry.contactPhone,
      text: message,
      accountId: account,
      typingDelayMs: typingDelay ? parseInt(typingDelay, 10) : undefined,
      pauseMs: pause ? parseInt(pause, 10) : undefined,
    });

    if (result.success) {
      console.log(`✓ Message sent to ${formatPhone(entry.contactPhone)}`);
    } else {
      fail(`Send failed: ${result.error}`);
    }
  }

  @Command({ name: "done", description: "Mark entry as done" })
  done(@Arg("id", { description: "Entry ID" }) id: string) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    dbUpdateEntry(id, { status: "done" });
    console.log(`✓ Entry marked as done: ${id}`);
  }

  @Command({ name: "complete", description: "Complete entry (no more follow-ups)" })
  complete(@Arg("id", { description: "Entry ID" }) id: string) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    dbUpdateEntry(id, { status: "done" });
    console.log(`✓ Entry completed: ${id}`);
  }

  @Command({ name: "skip", description: "Skip an entry" })
  skip(@Arg("id", { description: "Entry ID" }) id: string) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    dbUpdateEntry(id, { status: "skipped" });
    console.log(`✓ Entry skipped: ${id}`);
  }

  @Command({ name: "context", description: "Update entry context" })
  context(
    @Arg("id", { description: "Entry ID" }) id: string,
    @Arg("json", { description: "JSON context to merge" }) json: string,
  ) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    try {
      const ctx = JSON.parse(json);
      dbUpdateEntryContext(id, ctx);
      const updated = dbGetEntry(id)!;
      console.log(`✓ Context updated: ${id}`);
      console.log(`  ${JSON.stringify(updated.context)}`);
    } catch {
      fail("Invalid JSON");
    }
  }

  @Command({ name: "qualify", description: "Set qualification status on an entry" })
  qualify(
    @Arg("id", { description: "Entry ID" }) id: string,
    @Arg("status", { description: "Qualification: cold, warm, interested, qualified, rejected" }) status: string,
  ) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    const valid = ["cold", "warm", "interested", "qualified", "rejected"];
    if (!valid.includes(status)) {
      fail(`Invalid status: ${status}. Valid: ${valid.join(", ")}`);
    }

    dbUpdateEntry(id, { qualification: status as any });
    console.log(`✓ Qualification set: ${id} -> ${status}`);
  }

  @Command({ name: "reset", description: "Reset an entry to pending (clear rounds, responses, session)" })
  reset(
    @Arg("id", { description: "Entry ID" }) id: string,
    @Option({ flags: "--full", description: "Also clear context (preserves name)" }) full?: boolean,
  ) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    const queue = dbGetQueue(entry.queueId);
    const agentId = queue?.agentId ?? getDefaultAgentId();

    // Reset entry state
    // Use null cast to clear optional fields (undefined = "don't update" in dbUpdateEntry)
    const updates: Partial<any> = {
      status: "pending",
      roundsCompleted: 0,
      qualification: null,
      lastProcessedAt: null,
      lastSentAt: null,
      lastResponseAt: null,
      lastResponseText: null,
      senderId: null,
      pendingReceipt: null,
    };

    if (full) {
      // Clear context but keep name
      const cleanContext: Record<string, unknown> = {};
      if (entry.context.name) cleanContext.name = entry.context.name;
      updates.context = cleanContext;
    }

    dbUpdateEntry(id, updates);

    // Delete the SDK session so conversation starts fresh
    const sessionKey = `agent:${agentId}:outbound:${entry.queueId}:${entry.contactPhone}`;
    const routerDb = getDb();
    const sessionResult = routerDb.run("DELETE FROM sessions WHERE session_key = ?", sessionKey);

    // Delete chat history from chat.db
    const chatDb = new Database(join(homedir(), ".ravi", "chat.db"));
    const chatResult = chatDb.run("DELETE FROM messages WHERE session_id = ?", sessionKey);
    chatDb.close();

    console.log(`✓ Entry reset: ${id} (${formatPhone(entry.contactPhone)})`);
    if (full) console.log(`  Context cleared (name preserved)`);
    if (sessionResult.changes > 0) console.log(`  Session cleared`);
    if (chatResult.changes > 0) console.log(`  Chat history cleared (${chatResult.changes} messages)`);
  }

  @Command({ name: "run", description: "Manually trigger a queue", aliases: ["trigger"] })
  async run(@Arg("id", { description: "Queue ID" }) id: string) {
    const queue = dbGetQueue(id);
    if (!queue) fail(`Queue not found: ${id}`);

    console.log(`\nTriggering queue: ${queue.name}`);

    try {
      await notif.emit("ravi.outbound.trigger", { queueId: id });
      console.log("✓ Queue triggered");
      console.log("  Check daemon logs: ravi daemon logs -f");
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

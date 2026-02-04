/**
 * Outbound Commands - Outbound queue management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { notif } from "../../notif.js";
import { getAgent } from "../../router/config.js";
import { getDefaultTimezone } from "../../router/router-db.js";
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
      });

      console.log(`\n✓ Created queue: ${queue.id}`);
      console.log(`  Name:      ${queue.name}`);
      console.log(`  Interval:  ${formatDurationMs(queue.intervalMs)}`);
      console.log(`  Status:    paused`);
      console.log(`\nAdd entries: ravi outbound add ${queue.id} <phone>`);
      console.log(`Start:       ravi outbound start ${queue.id}`);
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

        default:
          fail(`Unknown property: ${key}. Valid: name, instructions, every, agent, description, active-start, active-end, tz`);
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
    @Option({ flags: "--email <email>", description: "Contact email" }) email?: string,
    @Option({ flags: "--tag <tag>", description: "Add all contacts with this tag" }) tag?: string,
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

    try {
      const entry = dbAddEntry({
        queueId,
        contactPhone: normalized,
        contactEmail: email,
      });

      console.log(`✓ Added entry: ${entry.id}`);
      console.log(`  Phone:    ${formatPhone(normalized)}`);
      console.log(`  Position: ${entry.position}`);
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
    console.log("  ID        POS  PHONE                  STATUS    ROUNDS  LAST RESPONSE");
    console.log("  --------  ---  --------------------   --------  ------  ----------------");

    for (const entry of entries) {
      const id = entry.id.padEnd(8);
      const pos = String(entry.position).padEnd(3);
      const phone = formatPhone(entry.contactPhone).padEnd(20);
      const status = `${statusColor(entry.status)}${entry.status.padEnd(8)}${RESET}`;
      const rounds = String(entry.roundsCompleted).padEnd(6);
      const lastResp = entry.lastResponseText
        ? entry.lastResponseText.slice(0, 16) + (entry.lastResponseText.length > 16 ? "..." : "")
        : "-";

      console.log(`  ${id}  ${pos}  ${phone}   ${status}  ${rounds}  ${lastResp}`);
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
    if (entry.contactEmail) console.log(`  Email:          ${entry.contactEmail}`);
    console.log(`  Position:       ${entry.position}`);
    console.log(`  Status:         ${statusColor(entry.status)}${entry.status}${RESET}`);
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

  // ========================================================================
  // Agent tool commands (used within outbound sessions)
  // ========================================================================

  @Command({ name: "send", description: "Send a message directly to a contact" })
  async send(
    @Arg("to", { description: "Phone number" }) to: string,
    @Arg("message", { description: "Message text" }) message: string,
    @Option({ flags: "--account <id>", description: "WhatsApp account ID" }) account?: string,
    @Option({ flags: "--typing-delay <ms>", description: "Typing indicator delay in ms before sending" }) typingDelay?: string,
  ) {
    const normalized = normalizePhone(to);

    const result = await directSend({
      to: normalized,
      text: message,
      accountId: account,
      typingDelayMs: typingDelay ? parseInt(typingDelay, 10) : undefined,
    });

    if (result.success) {
      console.log(`✓ Message sent to ${formatPhone(normalized)}`);
    } else {
      fail(`Send failed: ${result.error}`);
    }
  }

  @Command({ name: "done", description: "Mark an entry as done" })
  done(@Arg("id", { description: "Entry ID" }) id: string) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    dbMarkEntryDone(id);
    console.log(`✓ Entry marked done: ${id}`);
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
      console.log(`✓ Context updated: ${id}`);
    } catch {
      fail("Invalid JSON");
    }
  }

  @Command({ name: "reset", description: "Reset an entry to pending (clear rounds, responses, receipts)" })
  reset(@Arg("id", { description: "Entry ID" }) id: string) {
    const entry = dbGetEntry(id);
    if (!entry) fail(`Entry not found: ${id}`);

    dbUpdateEntry(id, {
      status: "pending",
      roundsCompleted: 0,
      lastProcessedAt: undefined,
      lastSentAt: undefined,
      lastResponseAt: undefined,
      lastResponseText: undefined,
      senderId: undefined,
      pendingReceipt: undefined,
    });
    console.log(`✓ Entry reset: ${id} (${formatPhone(entry.contactPhone)})`);
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

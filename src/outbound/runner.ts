/**
 * Outbound Runner
 *
 * Manages round-robin processing of outbound queues.
 * Follows the same pattern as CronRunner.
 */

import { notif } from "../notif.js";
import { logger } from "../utils/logger.js";
import { getDefaultAgentId } from "../router/router-db.js";
import { getContact } from "../contacts.js";
import {
  dbGetDueQueues,
  dbGetNextDueQueue,
  dbGetQueue,
  dbUpdateQueueState,
  dbUpdateQueue,
  dbGetNextEntry,
  dbRequeueEntry,
  dbUpdateEntry,
  dbListEntries,
  dbClearPendingReceipt,
} from "./outbound-db.js";
import type { OutboundQueue, OutboundEntry } from "./types.js";

const log = logger.child("outbound:runner");

/**
 * OutboundRunner - manages round-robin queue processing
 */
export class OutboundRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;

  /**
   * Start the outbound runner.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Starting outbound runner");

    this.armTimer();
    this.subscribeToConfigRefresh();
    this.subscribeToTriggerEvents();
    this.subscribeToDirectSend();

    log.info("Outbound runner started");
  }

  /**
   * Stop the outbound runner.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    log.info("Stopping outbound runner");

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    log.info("Outbound runner stopped");
  }

  /**
   * Set timer for the next due queue.
   */
  private armTimer(): void {
    if (!this.running) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const nextQueue = dbGetNextDueQueue();
    if (!nextQueue || !nextQueue.nextRunAt) {
      log.debug("No queues scheduled, timer idle");
      return;
    }

    const delay = Math.max(0, nextQueue.nextRunAt - Date.now());
    log.debug("Timer armed", {
      queueId: nextQueue.id,
      queueName: nextQueue.name,
      delay,
      nextRunAt: new Date(nextQueue.nextRunAt).toISOString(),
    });

    this.timer = setTimeout(() => {
      this.runDueQueues().catch(err => {
        log.error("Error running due queues", { error: err });
      });
    }, delay);
  }

  /**
   * Run all due queues.
   */
  private async runDueQueues(): Promise<void> {
    if (!this.running) return;
    if (this.processing) {
      log.debug("Already processing, skipping");
      return;
    }

    this.processing = true;

    try {
      const dueQueues = dbGetDueQueues();
      log.debug("Running due queues", { count: dueQueues.length });

      for (const queue of dueQueues) {
        if (!this.running) break;
        await this.processQueue(queue);
      }
    } finally {
      this.processing = false;
      this.armTimer();
    }
  }

  /**
   * Process a single queue - the core round-robin logic.
   */
  private async processQueue(queue: OutboundQueue): Promise<void> {
    const startTime = Date.now();
    const agentId = queue.agentId ?? getDefaultAgentId();

    log.info("Processing queue", { queueId: queue.id, queueName: queue.name, agentId });

    try {
      // Check active hours
      if (!this.isWithinActiveHours(queue)) {
        log.debug("Queue outside active hours, skipping", { queueId: queue.id });
        this.scheduleNext(queue, startTime);
        return;
      }

      // Flush all pending read receipts across all entries in this queue
      const allQueueEntries = dbListEntries(queue.id);
      for (const e of allQueueEntries) {
        if (e.pendingReceipt) {
          await notif.emit("ravi.outbound.receipt", { ...e.pendingReceipt });
          dbClearPendingReceipt(e.id);
          log.debug("Sent deferred read receipt", { entryId: e.id });
        }
      }

      // Get next entry (round-robin)
      const entry = dbGetNextEntry(queue.id, queue.currentIndex);

      if (!entry) {
        // No pending entries - check if all are done
        const allEntries = dbListEntries(queue.id);
        const pendingCount = allEntries.filter(e => e.status === "pending" || e.status === "active").length;

        if (pendingCount === 0 && allEntries.length > 0) {
          log.info("Queue completed - all entries processed", { queueId: queue.id });
          dbUpdateQueue(queue.id, { status: "completed" });
          dbUpdateQueueState(queue.id, {
            lastRunAt: startTime,
            lastStatus: "completed",
            lastDurationMs: Date.now() - startTime,
          });
          return;
        }

        log.debug("No entries to process", { queueId: queue.id });
        this.scheduleNext(queue, startTime);
        return;
      }

      // Mark entry as active
      dbUpdateEntry(entry.id, { status: "active", lastProcessedAt: startTime });

      // Send deferred read receipt if pending
      if (entry.pendingReceipt) {
        await notif.emit("ravi.outbound.receipt", { ...entry.pendingReceipt });
        dbClearPendingReceipt(entry.id);
        log.debug("Sent deferred read receipt", { entryId: entry.id });
      }

      // Build prompt for the agent
      const prompt = this.buildPrompt(queue, entry);

      // Session key: agent:{agentId}:outbound:{queueId}:{phone}
      const sessionKey = `agent:${agentId}:outbound:${queue.id}:${entry.contactPhone}`;

      // Emit prompt
      await notif.emit(`ravi.${sessionKey}.prompt`, {
        prompt,
        _outbound: true,
        _queueId: queue.id,
        _entryId: entry.id,
      });

      // Clear response text so it's not repeated in the next round
      if (entry.lastResponseText) {
        dbUpdateEntry(entry.id, { lastResponseText: undefined });
      }

      // Requeue entry (move to end of queue)
      dbRequeueEntry(entry.id);

      // Update queue state
      const nextIndex = entry.position + 1;
      dbUpdateQueueState(queue.id, {
        lastRunAt: startTime,
        lastStatus: "ok",
        lastDurationMs: Date.now() - startTime,
        nextRunAt: startTime + queue.intervalMs,
        currentIndex: nextIndex,
        totalProcessed: queue.totalProcessed + 1,
      });

      log.info("Queue entry processed", {
        queueId: queue.id,
        entryId: entry.id,
        phone: entry.contactPhone,
        nextRunIn: queue.intervalMs,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      dbUpdateQueueState(queue.id, {
        lastRunAt: startTime,
        lastStatus: "error",
        lastError: errorMessage,
        lastDurationMs: Date.now() - startTime,
        nextRunAt: startTime + queue.intervalMs,
      });

      log.error("Queue processing failed", {
        queueId: queue.id,
        error: errorMessage,
      });
    }
  }

  /**
   * Build the prompt for the agent with queue context.
   */
  private buildPrompt(queue: OutboundQueue, entry: OutboundEntry): string {
    const parts: string[] = [];

    parts.push(`[Outbound: ${queue.name}]`);
    parts.push("");
    parts.push("## Instructions");
    parts.push(queue.instructions);
    parts.push("");

    // Contact info
    parts.push("## Contact");
    const contact = getContact(entry.contactPhone);
    if (contact) {
      parts.push(`- Phone: ${entry.contactPhone}`);
      if (contact.name) parts.push(`- Name: ${contact.name}`);
      if (contact.email) parts.push(`- Email: ${contact.email}`);
      if (contact.tags.length > 0) parts.push(`- Tags: ${contact.tags.join(", ")}`);
      if (Object.keys(contact.notes).length > 0) {
        parts.push(`- Notes: ${JSON.stringify(contact.notes)}`);
      }
    } else {
      parts.push(`- Phone: ${entry.contactPhone}`);
      if (entry.contactEmail) parts.push(`- Email: ${entry.contactEmail}`);
    }
    parts.push("");

    // Entry context
    if (Object.keys(entry.context).length > 0) {
      parts.push("## Context");
      parts.push(JSON.stringify(entry.context, null, 2));
      parts.push("");
    }

    // Last response from contact
    if (entry.lastResponseText) {
      parts.push("## Last Response from Contact");
      parts.push(entry.lastResponseText);
      parts.push("");
    }

    // Metadata
    parts.push("## Metadata");
    parts.push(`- Entry ID: ${entry.id}`);
    parts.push(`- Queue ID: ${queue.id}`);
    parts.push(`- Round: ${entry.roundsCompleted + 1}`);
    parts.push(`- Current time: ${new Date().toISOString()}`);
    parts.push("");

    // Available tools hint
    parts.push("## Available Actions");
    parts.push("Use the following CLI tools to interact with this outbound session:");
    parts.push("- `mcp__ravi-cli__outbound_send <phone> <message>` - Send message to the contact via WhatsApp");
    parts.push("- `mcp__ravi-cli__outbound_done <entryId>` - Mark this entry as done (won't be processed again)");
    parts.push("- `mcp__ravi-cli__outbound_skip <entryId>` - Skip this entry for now");
    parts.push("- `mcp__ravi-cli__outbound_context <entryId> <json>` - Update context for next round");

    return parts.join("\n");
  }

  /**
   * Check if current time is within active hours.
   */
  private isWithinActiveHours(queue: OutboundQueue): boolean {
    if (!queue.activeStart || !queue.activeEnd) return true;

    const tz = queue.timezone;
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });
    const currentTime = formatter.format(now);

    return currentTime >= queue.activeStart && currentTime <= queue.activeEnd;
  }

  /**
   * Schedule next run for a queue.
   */
  private scheduleNext(queue: OutboundQueue, startTime: number): void {
    dbUpdateQueueState(queue.id, {
      lastRunAt: startTime,
      lastStatus: "skipped",
      nextRunAt: startTime + queue.intervalMs,
    });
  }

  /**
   * Refresh timers (called after config changes).
   */
  refreshTimers(): void {
    log.info("Refreshing outbound timers");
    this.armTimer();
  }

  /**
   * Manually trigger a queue (ignores schedule, runs immediately).
   */
  async triggerQueue(id: string): Promise<boolean> {
    const queue = dbGetQueue(id);
    if (!queue) {
      log.warn("Queue not found for manual trigger", { id });
      return false;
    }

    log.info("Manually triggering queue", { queueId: id, queueName: queue.name });
    await this.processQueue(queue);
    return true;
  }

  /**
   * Subscribe to config refresh signals from CLI.
   */
  private async subscribeToConfigRefresh(): Promise<void> {
    const topic = "ravi.outbound.refresh";
    log.debug("Subscribing to config refresh", { topic });

    try {
      for await (const _event of notif.subscribe(topic)) {
        if (!this.running) break;
        log.info("Received outbound config refresh signal");
        this.refreshTimers();
      }
    } catch (err) {
      log.error("Config refresh subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToConfigRefresh(), 5000);
      }
    }
  }

  /**
   * Subscribe to manual trigger events from CLI.
   */
  private async subscribeToTriggerEvents(): Promise<void> {
    const topic = "ravi.outbound.trigger";
    log.debug("Subscribing to trigger events", { topic });

    try {
      for await (const event of notif.subscribe(topic)) {
        if (!this.running) break;

        const data = event.data as { queueId?: string };
        if (!data.queueId) continue;

        log.info("Received manual trigger", { queueId: data.queueId });
        await this.triggerQueue(data.queueId);
      }
    } catch (err) {
      log.error("Trigger subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToTriggerEvents(), 5000);
      }
    }
  }

  /**
   * Subscribe to direct send events.
   * Handles outbound.send events from directSend() function.
   */
  private async subscribeToDirectSend(): Promise<void> {
    const topic = "ravi.outbound.send";
    log.debug("Subscribing to direct send events", { topic });

    try {
      for await (const event of notif.subscribe(topic)) {
        if (!this.running) break;

        const data = event.data as {
          channel: string;
          accountId: string;
          to: string;
          text: string;
          typingDelayMs?: number;
        };

        log.info("Direct send event", { to: data.to, channel: data.channel });

        // Re-emit to the channel plugin's outbound topic
        // The gateway's response handler picks this up
        // We use a special topic that gateway subscribes to
        await notif.emit(`ravi.outbound.deliver`, {
          channel: data.channel,
          accountId: data.accountId,
          to: data.to,
          text: data.text,
          typingDelayMs: data.typingDelayMs,
        });
      }
    } catch (err) {
      log.error("Direct send subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToDirectSend(), 5000);
      }
    }
  }
}

// Singleton instance
let runner: OutboundRunner | null = null;

/**
 * Get or create the outbound runner instance.
 */
export function getOutboundRunner(): OutboundRunner {
  if (!runner) {
    runner = new OutboundRunner();
  }
  return runner;
}

/**
 * Start the outbound runner.
 */
export async function startOutboundRunner(): Promise<void> {
  await getOutboundRunner().start();
}

/**
 * Stop the outbound runner.
 */
export async function stopOutboundRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}

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
  dbGetNextEntryWithResponse,
  dbUpdateEntry,
  dbListEntries,
  dbClearPendingReceipt,
  dbClearResponseText,
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

      // Priority 1: Process entries with pending responses (contact replied)
      const responseEntry = dbGetNextEntryWithResponse(queue.id);
      if (responseEntry) {
        log.info("Processing response entry", { entryId: responseEntry.id, phone: responseEntry.contactPhone });
        await this.processEntry(queue, responseEntry, agentId, startTime);

        // Event path: only lastRunAt + totalProcessed, no currentIndex change
        dbUpdateQueueState(queue.id, {
          lastRunAt: startTime,
          lastStatus: "ok",
          lastDurationMs: Date.now() - startTime,
          nextRunAt: startTime + queue.intervalMs,
          totalProcessed: queue.totalProcessed + 1,
        });
        return;
      }

      // Priority 2: Initial outreach (only pending + round 0)
      const entry = dbGetNextEntry(queue.id, queue.currentIndex);

      if (!entry) {
        // No pending entries - check if all are done (permanently finished)
        const allEntries = dbListEntries(queue.id);
        const notDoneCount = allEntries.filter(e => e.status !== "done").length;

        if (notDoneCount === 0 && allEntries.length > 0) {
          log.info("Queue completed - all entries done", { queueId: queue.id });
          dbUpdateQueue(queue.id, { status: "completed" });
          dbUpdateQueueState(queue.id, {
            lastRunAt: startTime,
            lastStatus: "completed",
            lastDurationMs: Date.now() - startTime,
          });
          return;
        }

        log.debug("No entries ready for initial outreach", { queueId: queue.id });
        this.scheduleNext(queue, startTime);
        return;
      }

      // Process initial outreach
      await this.processEntry(queue, entry, agentId, startTime);

      // Timer path: advance currentIndex + schedule next
      const nextIndex = entry.position + 1;
      dbUpdateQueueState(queue.id, {
        lastRunAt: startTime,
        lastStatus: "ok",
        lastDurationMs: Date.now() - startTime,
        nextRunAt: startTime + queue.intervalMs,
        currentIndex: nextIndex,
        totalProcessed: queue.totalProcessed + 1,
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
   * Process a specific entry (initial outreach or contact response).
   * Does NOT update queue state — caller is responsible for that.
   */
  private async processEntry(
    queue: OutboundQueue,
    entry: OutboundEntry,
    agentId: string,
    startTime: number,
  ): Promise<void> {
    // Mark active + increment round
    dbUpdateEntry(entry.id, {
      status: "active",
      lastProcessedAt: startTime,
      roundsCompleted: entry.roundsCompleted + 1,
    });

    // Send deferred read receipt if pending (only for THIS entry)
    if (entry.pendingReceipt) {
      await notif.emit("ravi.outbound.receipt", { ...entry.pendingReceipt });
      dbClearPendingReceipt(entry.id);
      log.debug("Sent deferred read receipt", { entryId: entry.id });
    }

    // Build system context (injected into system prompt, not user-visible)
    const systemContext = this.buildSystemContext(queue, entry);

    // Build user prompt: just the actionable part
    const isFollowUp = !!entry.lastResponseText;
    const prompt = isFollowUp
      ? this.buildFollowUpPrompt(queue, entry)
      : this.buildOutreachPrompt(queue, entry);

    // Session key: agent:{agentId}:outbound:{queueId}:{phone}
    const sessionKey = `agent:${agentId}:outbound:${queue.id}:${entry.contactPhone}`;

    log.info("Sending prompt to agent", {
      entryId: entry.id,
      phone: entry.contactPhone,
      isFollowUp,
      roundsCompleted: entry.roundsCompleted,
      sessionKey,
      prompt,
    });

    // Emit prompt
    await notif.emit(`ravi.${sessionKey}.prompt`, {
      prompt,
      _outbound: true,
      _outboundSystemContext: systemContext,
      _queueId: queue.id,
      _entryId: entry.id,
    });

    // Clear response text so it's not repeated
    if (entry.lastResponseText) {
      dbClearResponseText(entry.id);
    }

    log.info("Entry processed", {
      queueId: queue.id,
      entryId: entry.id,
      phone: entry.contactPhone,
      round: entry.roundsCompleted + 1,
    });
  }

  /**
   * Build system context (injected into system prompt, invisible to user).
   * Contains instructions, available tools, and metadata.
   */
  private buildSystemContext(queue: OutboundQueue, entry: OutboundEntry): string {
    const parts: string[] = [];

    parts.push(`[Outbound Session: ${queue.name}]`);
    parts.push("");
    parts.push("## Queue Instructions");
    parts.push(queue.instructions);
    parts.push("");
    parts.push("## Available Actions");
    parts.push(`- \`mcp__ravi-cli__outbound_send ${entry.contactPhone} <message>\` — Send WhatsApp message (use --typing-delay 3000-6000)`);
    parts.push(`- \`mcp__ravi-cli__outbound_done ${entry.id}\` — Mark entry as done`);
    parts.push(`- \`mcp__ravi-cli__outbound_skip ${entry.id}\` — Skip for now`);
    parts.push(`- \`mcp__ravi-cli__outbound_context ${entry.id} <json>\` — Save context for next round`);
    parts.push("");
    parts.push("## Metadata");
    parts.push(`Entry ID: ${entry.id} | Queue ID: ${queue.id} | Round: ${entry.roundsCompleted + 1}`);

    return parts.join("\n");
  }

  /**
   * Build user prompt for initial outreach.
   * Just the contact info — instructions are in system prompt.
   */
  private buildOutreachPrompt(queue: OutboundQueue, entry: OutboundEntry): string {
    const parts: string[] = [];

    parts.push(`[Outbound: ${queue.name} — Contato novo]`);
    parts.push("");

    // Contact info
    const contact = getContact(entry.contactPhone);
    const contextName = entry.context.name as string | undefined;

    parts.push(`Telefone: ${entry.contactPhone}`);

    // Name: prefer contacts DB, fallback to entry context
    const name = contact?.name ?? contextName;
    if (name) parts.push(`Nome: ${name}`);

    // Email: prefer contacts DB, fallback to entry field
    const email = contact?.email ?? entry.contactEmail;
    if (email) parts.push(`Email: ${email}`);

    // Contact-level metadata
    if (contact) {
      if (contact.tags.length > 0) parts.push(`Tags: ${contact.tags.join(", ")}`);
      if (Object.keys(contact.notes).length > 0) {
        parts.push(`Notas: ${JSON.stringify(contact.notes)}`);
      }
    }

    // Entry context (exclude 'name' since it's shown above)
    const { name: _name, ...restContext } = entry.context;
    if (Object.keys(restContext).length > 0) {
      parts.push("");
      parts.push(`Contexto: ${JSON.stringify(restContext)}`);
    }

    return parts.join("\n");
  }

  /**
   * Build user prompt for follow-up (contact responded).
   */
  private buildFollowUpPrompt(queue: OutboundQueue, entry: OutboundEntry): string {
    const parts: string[] = [];

    parts.push(`[Outbound: ${queue.name} — O contato respondeu]`);
    parts.push("");
    parts.push(entry.lastResponseText!);

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
    this.armTimer();
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

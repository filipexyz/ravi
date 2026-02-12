/**
 * Trigger Runner
 *
 * Manages event-driven trigger subscriptions on notif topics.
 * When an event fires on a matching topic, builds a prompt and
 * emits it to the agent session.
 */

import { notif } from "../notif.js";
import { logger } from "../utils/logger.js";
import { getDefaultAgentId } from "../router/router-db.js";
import {
  getMainSession,
  getOrCreateSession,
  resolveSession,
  generateSessionName,
  ensureUniqueName,
  updateSessionName,
  expandHome,
} from "../router/index.js";
import { getAgent } from "../router/config.js";
import { dbListTriggers, dbGetTrigger, dbUpdateTriggerState } from "./triggers-db.js";
import type { Trigger } from "./types.js";

const log = logger.child("triggers:runner");

/** Tracks a topic subscription stream for teardown */
type TopicSub = ReturnType<typeof notif.subscribe>;

/**
 * TriggerRunner - manages event-driven trigger subscriptions
 */
export class TriggerRunner {
  /** Topic streams (NOT including refresh/test — those are long-lived) */
  private topicSubs: TopicSub[] = [];
  private running = false;

  /**
   * Start the trigger runner.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Starting trigger runner");

    await this.setupSubscriptions();
    this.subscribeToConfigRefresh();
    this.subscribeToTestEvents();

    log.info("Trigger runner started");
  }

  /**
   * Stop the trigger runner.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    log.info("Stopping trigger runner");

    this.teardownSubscriptions();

    log.info("Trigger runner stopped");
  }

  /**
   * Tear down all topic subscriptions.
   */
  private teardownSubscriptions(): void {
    for (const sub of this.topicSubs) {
      try {
        sub.close();
      } catch {
        // ignore close errors
      }
    }
    this.topicSubs = [];
  }

  /**
   * Set up subscriptions for all enabled triggers.
   */
  private async setupSubscriptions(): Promise<void> {
    // Tear down existing
    this.teardownSubscriptions();

    const triggers = dbListTriggers({ enabledOnly: true });

    // Group by topic to share subscriptions
    const byTopic = new Map<string, Trigger[]>();
    for (const t of triggers) {
      const list = byTopic.get(t.topic) || [];
      list.push(t);
      byTopic.set(t.topic, list);
    }

    // Internal bot topics that must never be trigger sources (loop risk)
    const blockedPatterns = [".prompt", ".response", ".claude"];

    for (const [topic, trigs] of byTopic) {
      if (blockedPatterns.some((p) => topic.includes(p))) {
        log.warn("Skipping trigger on internal topic (anti-loop)", { topic });
        continue;
      }
      this.subscribeToTopic(topic, trigs);
    }

    log.info("Subscriptions set up", {
      topics: byTopic.size,
      triggers: triggers.length,
    });
  }

  /**
   * Subscribe to a notif topic and fire matching triggers.
   */
  private subscribeToTopic(topic: string, triggers: Trigger[]): void {
    const stream = notif.subscribe(topic);
    this.topicSubs.push(stream);

    // Run subscription loop in background
    (async () => {
      try {
        for await (const event of stream) {
          if (!this.running) break;

          // Skip events from trigger sessions (prevents self-fire loops)
          // Trigger sessions use pattern: ravi.agent:{id}:trigger:{triggerId}.*
          if (event.topic.includes(":trigger:")) continue;
          // Also skip events explicitly tagged as trigger-originated
          const eventData = event.data as Record<string, unknown> | undefined;
          if (eventData?._trigger) continue;

          for (const trigger of triggers) {
            // Cooldown check
            if (
              trigger.lastFiredAt &&
              Date.now() - trigger.lastFiredAt < trigger.cooldownMs
            ) {
              log.debug("Trigger cooldown active, skipping", {
                triggerId: trigger.id,
                triggerName: trigger.name,
              });
              continue;
            }

            this.fireTrigger(trigger, event).catch((err) => {
              log.error("Error firing trigger", {
                triggerId: trigger.id,
                error: err,
              });
            });
          }
        }
      } catch (err) {
        // Stream closed is expected during teardown
        if (!this.running) return;

        log.error("Topic subscription error", { topic, error: err });
        // Retry after delay
        setTimeout(() => {
          if (this.running) {
            this.subscribeToTopic(topic, triggers);
          }
        }, 5000);
      }
    })();

    log.debug("Subscribed to topic", { topic, triggerCount: triggers.length });
  }

  /**
   * Fire a trigger with event data.
   */
  private async fireTrigger(
    trigger: Trigger,
    event: { topic: string; data: unknown }
  ): Promise<void> {
    const agentId = trigger.agentId ?? getDefaultAgentId();
    const agent = getAgent(agentId);
    const agentCwd = agent ? expandHome(agent.cwd) : `/tmp/ravi-${agentId}`;

    let sessionName: string;

    if (trigger.session === "main") {
      const main = getMainSession(agentId);
      if (main?.name) {
        sessionName = main.name;
      } else {
        const baseName = generateSessionName(agentId, { isMain: true });
        sessionName = ensureUniqueName(baseName);
        const session = getOrCreateSession(`agent:${agentId}:main`, agentId, agentCwd, { name: sessionName });
        if (!session.name) updateSessionName(session.sessionKey, sessionName);
      }
    } else {
      const dbKey = `agent:${agentId}:trigger:${trigger.id}`;
      const existing = resolveSession(dbKey);
      if (existing?.name) {
        sessionName = existing.name;
      } else {
        const baseName = generateSessionName(agentId, { suffix: `trigger-${trigger.name}` });
        sessionName = ensureUniqueName(baseName);
        const session = getOrCreateSession(dbKey, agentId, agentCwd, { name: sessionName });
        if (!session.name) updateSessionName(session.sessionKey, sessionName);
      }
    }

    const prompt = [
      `[Trigger: ${trigger.name}]`,
      `Topic: ${event.topic}`,
      `Data: ${JSON.stringify(event.data, null, 2)}`,
      ``,
      trigger.message,
    ].join("\n");

    log.info("Firing trigger", {
      triggerId: trigger.id,
      triggerName: trigger.name,
      topic: event.topic,
      sessionName,
    });

    await notif.emit(`ravi.session.${sessionName}.prompt`, {
      prompt,
      _trigger: true,
      _triggerId: trigger.id,
    });

    dbUpdateTriggerState(trigger.id, {
      lastFiredAt: Date.now(),
      incrementFire: true,
    });

    // Update in-memory trigger too (for cooldown tracking)
    trigger.lastFiredAt = Date.now();
  }

  /**
   * Subscribe to config refresh signals from CLI.
   */
  private async subscribeToConfigRefresh(): Promise<void> {
    const topic = "ravi.triggers.refresh";
    log.debug("Subscribing to config refresh", { topic });

    try {
      for await (const _event of notif.subscribe(topic)) {
        if (!this.running) break;
        log.info("Received triggers config refresh signal");
        await this.setupSubscriptions();
      }
    } catch (err) {
      log.error("Config refresh subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToConfigRefresh(), 5000);
      }
    }
  }

  /**
   * Subscribe to test events from CLI.
   */
  private async subscribeToTestEvents(): Promise<void> {
    const topic = "ravi.triggers.test";
    log.debug("Subscribing to test events", { topic });

    try {
      for await (const event of notif.subscribe(topic)) {
        if (!this.running) break;

        const data = event.data as { triggerId?: string };
        if (!data.triggerId) continue;

        log.info("Received test trigger", { triggerId: data.triggerId });

        const trigger = dbGetTrigger(data.triggerId);
        if (!trigger) {
          log.warn("Trigger not found for test", { triggerId: data.triggerId });
          continue;
        }

        await this.fireTrigger(trigger, {
          topic: trigger.topic,
          data: {
            _test: true,
            message: "Test event fired via CLI",
            timestamp: new Date().toISOString(),
          },
        });
      }
    } catch (err) {
      log.error("Test subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToTestEvents(), 5000);
      }
    }
  }
}

// Singleton instance
let runner: TriggerRunner | null = null;

/**
 * Get or create the trigger runner instance.
 */
export function getTriggerRunner(): TriggerRunner {
  if (!runner) {
    runner = new TriggerRunner();
  }
  return runner;
}

/**
 * Start the trigger runner.
 */
export async function startTriggerRunner(): Promise<void> {
  await getTriggerRunner().start();
}

/**
 * Stop the trigger runner.
 */
export async function stopTriggerRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}

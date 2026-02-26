/**
 * Trigger Runner
 *
 * Manages event-driven trigger subscriptions on NATS topics.
 * When an event fires on a matching topic, builds a prompt and
 * emits it to the agent session.
 */

import { nats } from "../nats.js";
import { logger } from "../utils/logger.js";
import { getDefaultAgentId } from "../router/router-db.js";
import { deriveSourceFromSessionKey } from "../router/session-key.js";
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
import { evaluateFilter } from "./filter.js";
import { resolveTemplate } from "./template.js";
import type { Trigger } from "./types.js";

const log = logger.child("triggers:runner");

/** Tracks a topic subscription stream for teardown */
type TopicSub = ReturnType<typeof nats.subscribe>;

/**
 * TriggerRunner - manages event-driven trigger subscriptions
 */
export class TriggerRunner {
  /** Topic streams (NOT including refresh/test — those are long-lived) */
  private topicSubs: TopicSub[] = [];
  private running = false;
  /** Prevents concurrent setupSubscriptions() calls from corrupting topicSubs */
  private setupInProgress = false;
  private setupQueued = false;

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
    // Serialize: if already running, queue one more execution and return.
    // Any additional calls while queued are no-ops — they'll be covered by the queued run.
    if (this.setupInProgress) {
      this.setupQueued = true;
      return;
    }
    this.setupInProgress = true;

    try {
      await this._doSetupSubscriptions();
    } finally {
      this.setupInProgress = false;
      if (this.setupQueued) {
        this.setupQueued = false;
        // Process the queued request (tail-recursive, but setupInProgress is false now)
        await this.setupSubscriptions();
      }
    }
  }

  private async _doSetupSubscriptions(): Promise<void> {
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

    // Internal session topics that must never be trigger sources (loop risk).
    // Pattern: ravi.session.<name>.prompt / .response / .claude
    // We block by prefix "ravi.session." to avoid false positives on external
    // topics like ravi.copilot.prompt that legitimately contain ".prompt".
    const blockedPrefixes = ["ravi.session."];

    for (const [topic, trigs] of byTopic) {
      if (blockedPrefixes.some((p) => topic.startsWith(p))) {
        log.warn("Skipping trigger on internal session topic (anti-loop)", { topic });
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
   * Subscribe to a NATS topic and fire matching triggers.
   */
  private subscribeToTopic(topic: string, triggers: Trigger[]): void {
    const stream = nats.subscribe(topic);
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

            // Filter check: evaluate trigger's filter expression against event data
            if (!evaluateFilter(trigger.filter, event.data)) {
              log.debug("Trigger filter did not match, skipping", {
                triggerId: trigger.id,
                triggerName: trigger.name,
                filter: trigger.filter,
              });
              continue;
            }

            // Set cooldown immediately to prevent race condition:
            // Without this, multiple events arriving in rapid succession
            // all pass the cooldown check before the first fireTrigger
            // completes and updates lastFiredAt.
            trigger.lastFiredAt = Date.now();

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
    let source: { channel: string; accountId: string; chatId: string } | undefined;

    if (trigger.session === "main") {
      // If replySession is set, resolve it for session name + source routing
      if (trigger.replySession) {
        const resolved = resolveSession(trigger.replySession);
        if (resolved?.name) {
          sessionName = resolved.name;
          if (resolved.lastChannel && resolved.lastTo) {
            source = { channel: resolved.lastChannel, accountId: trigger.accountId ?? resolved.lastAccountId ?? "", chatId: resolved.lastTo };
          }
        } else {
          // Fallback: derive source from session key and use main session
          source = deriveSourceFromSessionKey(trigger.replySession) ?? undefined;
          sessionName = this.resolveMainSessionName(agentId, agentCwd);
        }
      } else {
        sessionName = this.resolveMainSessionName(agentId, agentCwd);
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

      // Derive source from replySession for isolated sessions too
      if (trigger.replySession) {
        const replyResolved = resolveSession(trigger.replySession);
        if (replyResolved?.lastChannel && replyResolved.lastTo) {
          source = { channel: replyResolved.lastChannel, accountId: trigger.accountId ?? replyResolved.lastAccountId ?? "", chatId: replyResolved.lastTo };
        } else {
          source = deriveSourceFromSessionKey(trigger.replySession) ?? undefined;
        }
      }
    }

    // Override accountId in source if trigger has explicit accountId
    if (source && trigger.accountId) {
      source.accountId = trigger.accountId;
    }

    const prompt = resolveTemplate(trigger.message, {
      topic: event.topic,
      data: event.data,
    });

    log.info("Firing trigger", {
      triggerId: trigger.id,
      triggerName: trigger.name,
      topic: event.topic,
      sessionName,
      hasSource: !!source,
    });

    await nats.emit(`ravi.session.${sessionName}.prompt`, {
      prompt,
      source,
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
   * Resolve main session name for an agent.
   */
  private resolveMainSessionName(agentId: string, agentCwd: string): string {
    const main = getMainSession(agentId);
    if (main?.name) return main.name;

    const baseName = generateSessionName(agentId, { isMain: true });
    const sessionName = ensureUniqueName(baseName);
    const session = getOrCreateSession(`agent:${agentId}:main`, agentId, agentCwd, { name: sessionName });
    if (!session.name) updateSessionName(session.sessionKey, sessionName);
    return sessionName;
  }

  /**
   * Subscribe to config refresh signals from CLI.
   */
  private async subscribeToConfigRefresh(): Promise<void> {
    const topic = "ravi.triggers.refresh";
    log.debug("Subscribing to config refresh", { topic });

    try {
      for await (const _event of nats.subscribe(topic)) {
        if (!this.running) break;
        log.info("Received triggers config refresh signal");
        // setupSubscriptions is serialized internally: concurrent calls collapse into one queued run
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
      for await (const event of nats.subscribe(topic)) {
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

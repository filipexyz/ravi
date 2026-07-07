/**
 * Trigger Runner
 *
 * Manages event-driven trigger subscriptions on NATS topics.
 * When an event fires on a matching topic, builds a prompt and
 * emits it to the agent session.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nats } from "../nats.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
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
import type { Trigger } from "./types.js";
import { isBlockedTriggerTopic } from "./topic-policy.js";
import { buildTriggerPrompt } from "./prompt.js";
import { DEFAULT_CRON_SHELL_TIMEOUT_MS, runShellCronCommand, type ShellCronRunResult } from "../cron/shell-executor.js";

const log = logger.child("triggers:runner");
const EVENT_DEDUPE_TTL_MS = 60_000;
const EVENT_DEDUPE_MAX = 2_000;

/** Tracks a topic subscription stream for teardown */
type TopicSub = ReturnType<typeof nats.subscribe>;

/**
 * TriggerRunner - manages event-driven trigger subscriptions
 */
export class TriggerRunner {
  /** Topic streams (NOT including refresh/test — those are long-lived) */
  private topicSubs: TopicSub[] = [];
  private running = false;
  private recentEventFires = new Map<string, number>();
  private recentEventFireOps = 0;

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
        sub.return?.(undefined);
      } catch {
        // ignore close errors
      }
    }
    this.topicSubs = [];
  }

  // Mutex to prevent concurrent setupSubscriptions calls
  private setupInProgress = false;
  private setupQueued = false;

  /**
   * Set up subscriptions for all enabled triggers.
   * Serialized: concurrent calls are collapsed into one queued re-run.
   */
  private async setupSubscriptions(): Promise<void> {
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
        this.setupSubscriptions();
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

    for (const [topic, trigs] of byTopic) {
      if (isBlockedTriggerTopic(topic)) {
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
            if (trigger.lastFiredAt && Date.now() - trigger.lastFiredAt < trigger.cooldownMs) {
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

            const dedupeKey = getTriggerEventDedupeKey(trigger, event);
            if (this.wasRecentlyFired(dedupeKey)) {
              log.debug("Trigger event already handled recently, skipping duplicate", {
                triggerId: trigger.id,
                triggerName: trigger.name,
                topic: event.topic,
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

  private wasRecentlyFired(key: string): boolean {
    const now = Date.now();
    const previous = this.recentEventFires.get(key);
    if (previous !== undefined && now - previous < EVENT_DEDUPE_TTL_MS) return true;

    this.recentEventFires.set(key, now);
    if (++this.recentEventFireOps >= 200 || this.recentEventFires.size > EVENT_DEDUPE_MAX) {
      this.recentEventFireOps = 0;
      for (const [candidate, timestamp] of this.recentEventFires) {
        if (now - timestamp > EVENT_DEDUPE_TTL_MS || this.recentEventFires.size > EVENT_DEDUPE_MAX) {
          this.recentEventFires.delete(candidate);
        }
      }
    }
    return false;
  }

  /**
   * Fire a trigger with event data.
   */
  private async fireTrigger(trigger: Trigger, event: { topic: string; data: unknown }): Promise<void> {
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
            source = {
              channel: resolved.lastChannel,
              accountId: trigger.accountId ?? resolved.lastAccountId ?? "",
              chatId: resolved.lastTo,
            };
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
          source = {
            channel: replyResolved.lastChannel,
            accountId: trigger.accountId ?? replyResolved.lastAccountId ?? "",
            chatId: replyResolved.lastTo,
          };
        } else {
          source = deriveSourceFromSessionKey(trigger.replySession) ?? undefined;
        }
      }
    }

    // Final fallback: the source the creator was talking to when the trigger
    // was registered. Frozen at creation time, immune to later session edits.
    if (!source && trigger.replySource) {
      source = {
        channel: trigger.replySource.channel,
        accountId: trigger.accountId ?? trigger.replySource.accountId,
        chatId: trigger.replySource.chatId,
      };
    }

    // Override accountId in source if trigger has explicit accountId
    if (source && trigger.accountId) {
      source.accountId = trigger.accountId;
    }

    if ((trigger.executionType ?? "agent") === "shell") {
      await this.fireShellTrigger(trigger, event, source);
      return;
    }

    const prompt = buildTriggerPrompt(trigger, event);

    log.info("Firing trigger", {
      triggerId: trigger.id,
      triggerName: trigger.name,
      topic: event.topic,
      sessionName,
      hasSource: !!source,
    });

    await publishSessionPrompt(sessionName, {
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

  private truncateForPrompt(text: string, max = 4000): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
  }

  private formatShellError(result: ShellCronRunResult): string {
    const exit = result.timedOut
      ? `timeout after ${result.durationMs}ms`
      : result.signal
        ? `signal ${result.signal}`
        : `exit code ${result.exitCode ?? "unknown"}`;
    const stderr = result.stderr.trim();
    return stderr
      ? `Shell trigger command failed with ${exit}: ${this.truncateForPrompt(stderr)}`
      : `Shell trigger command failed with ${exit}`;
  }

  private buildShellEnv(
    trigger: Trigger,
    event: { topic: string; data: unknown },
    source: { channel: string; accountId: string; chatId: string } | undefined,
    eventFile: string,
    dataFile: string,
  ): Record<string, string> {
    const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
    const stringField = (key: string): string => {
      const value = data[key];
      return typeof value === "string" ? value : "";
    };

    return {
      RAVI_TRIGGER_ID: trigger.id,
      RAVI_TRIGGER_NAME: trigger.name,
      RAVI_TRIGGER_TOPIC: event.topic,
      RAVI_TRIGGER_EVENT_FILE: eventFile,
      RAVI_TRIGGER_DATA_FILE: dataFile,
      RAVI_TRIGGER_SOURCE_CHANNEL: source?.channel ?? "",
      RAVI_TRIGGER_SOURCE_ACCOUNT_ID: source?.accountId ?? "",
      RAVI_TRIGGER_SOURCE_CHAT_ID: source?.chatId ?? "",
      RAVI_TRIGGER_PROVIDER: stringField("provider"),
      RAVI_TRIGGER_INTERACTION_TYPE: stringField("interactionType"),
      RAVI_TRIGGER_ACTION_ID: stringField("actionId"),
      RAVI_TRIGGER_BLOCK_ID: stringField("blockId"),
      RAVI_TRIGGER_VALUE: stringField("value"),
      RAVI_TRIGGER_USER_ID: stringField("userId"),
      RAVI_TRIGGER_CHANNEL_ID: stringField("channelId"),
      RAVI_TRIGGER_MESSAGE_TS: stringField("messageTs"),
      RAVI_TRIGGER_THREAD_TS: stringField("threadTs"),
      RAVI_TRIGGER_RESPONSE_URL_ID: stringField("responseUrlId"),
    };
  }

  private async notifyShellTriggerError(
    trigger: Trigger,
    result: ShellCronRunResult,
    errorMessage: string,
  ): Promise<void> {
    if (!trigger.onError) return;
    const prefix = "notify-session:";
    if (!trigger.onError.startsWith(prefix)) {
      log.warn("Unsupported trigger on-error action", { triggerId: trigger.id, onError: trigger.onError });
      return;
    }

    const sessionRef = trigger.onError.slice(prefix.length).trim();
    if (!sessionRef) {
      log.warn("Trigger on-error notify-session missing target", { triggerId: trigger.id });
      return;
    }

    const resolved = resolveSession(sessionRef);
    const sessionName = resolved?.name ?? sessionRef;
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    const prompt = [
      `[System] Inform: [from: trigger:${trigger.id}] Trigger shell command failed.`,
      "",
      `Trigger: ${trigger.name}`,
      `Topic: ${trigger.topic}`,
      `Command: ${trigger.shellCommand ?? result.command}`,
      `Error: ${errorMessage}`,
      `Exit code: ${result.exitCode ?? "(none)"}`,
      `Signal: ${result.signal ?? "(none)"}`,
      `Duration: ${result.durationMs}ms`,
      stderr ? `\nStderr:\n${this.truncateForPrompt(stderr)}` : "",
      stdout ? `\nStdout:\n${this.truncateForPrompt(stdout)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await publishSessionPrompt(sessionName, {
      prompt,
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      _trigger: true,
      _triggerId: trigger.id,
      _triggerOnError: true,
    });
  }

  private async fireShellTrigger(
    trigger: Trigger,
    event: { topic: string; data: unknown },
    source: { channel: string; accountId: string; chatId: string } | undefined,
  ): Promise<void> {
    if (!trigger.shellCommand?.trim()) {
      throw new Error("Shell trigger is missing shellCommand");
    }

    const firedAt = Date.now();
    const tempDir = await mkdtemp(join(tmpdir(), "ravi-trigger-shell-"));
    const eventFile = join(tempDir, "event.json");
    const dataFile = join(tempDir, "data.json");

    try {
      await writeFile(
        eventFile,
        JSON.stringify(
          {
            trigger: {
              id: trigger.id,
              name: trigger.name,
              topic: trigger.topic,
            },
            event,
            source,
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(dataFile, JSON.stringify(event.data ?? null, null, 2), "utf8");

      log.info("Firing shell trigger", {
        triggerId: trigger.id,
        triggerName: trigger.name,
        topic: event.topic,
        hasSource: !!source,
      });

      const result = await runShellCronCommand(trigger.shellCommand, {
        timeoutMs: trigger.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS,
        envFile: trigger.shellEnvFile,
        env: this.buildShellEnv(trigger, event, source, eventFile, dataFile),
      });

      if (result.stdout.trim()) {
        log.info("Shell trigger stdout", {
          triggerId: trigger.id,
          output: this.truncateForPrompt(result.stdout.trim()),
        });
      }
      if (result.stderr.trim()) {
        log.warn("Shell trigger stderr", {
          triggerId: trigger.id,
          output: this.truncateForPrompt(result.stderr.trim()),
        });
      }

      const ok = !result.timedOut && result.exitCode === 0;
      const errorMessage = ok ? undefined : this.formatShellError(result);

      if (!ok && errorMessage) {
        try {
          await this.notifyShellTriggerError(trigger, result, errorMessage);
        } catch (notifyError) {
          log.error("Failed to notify session about trigger shell error", {
            triggerId: trigger.id,
            error: notifyError instanceof Error ? notifyError.message : String(notifyError),
          });
        }
      }

      log.info("Shell trigger completed", {
        triggerId: trigger.id,
        triggerName: trigger.name,
        status: ok ? "ok" : "error",
        exitCode: result.exitCode,
        signal: result.signal,
        durationMs: result.durationMs,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      dbUpdateTriggerState(trigger.id, {
        lastFiredAt: firedAt,
        incrementFire: true,
      });
      trigger.lastFiredAt = firedAt;
    }
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

export function getTriggerEventDedupeKey(
  trigger: Pick<Trigger, "id">,
  event: { topic: string; data: unknown },
): string {
  const identity =
    readStringPath(event.data, "dedupeKey") ??
    readStringPath(event.data, "eventId") ??
    readStringPath(event.data, "inboxItemId") ??
    readStringPath(event.data, "sourceId") ??
    readStringPath(event.data, "messageId") ??
    readStringPath(event.data, "mail.messageId") ??
    readStringPath(event.data, "mail.providerMessageId") ??
    readStringPath(event.data, "payload.messageId") ??
    readStringPath(event.data, "payload.mail.messageId") ??
    readStringPath(event.data, "payload.mail.localIngest.messageId") ??
    readStringPath(event.data, "source.id");

  if (identity) return `${trigger.id}\0${event.topic}\0${identity}`;

  const payloadHash = createHash("sha256").update(stableStringify(event.data)).digest("hex");
  return `${trigger.id}\0${event.topic}\0payload:${payloadHash}`;
}

function readStringPath(value: unknown, path: string): string | null {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableStringify(value));
}

function sortForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForStableStringify);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortForStableStringify(record[key]);
  }
  return sorted;
}

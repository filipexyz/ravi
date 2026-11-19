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
import { nats, getNats } from "../nats.js";
import type { Subscription } from "nats";
import { followFingerprint, followHealthTopic } from "../pr/follow-health.js";
import { getLocalWatchRunner } from "../watch/local-runner.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";
import { canonicalChannelId } from "../channels/capabilities.js";
import { dbGetInstance, getDefaultAgentId } from "../router/router-db.js";
import { deriveSourceFromSessionKey } from "../router/session-key.js";
import {
  getMainSession,
  getOrCreateSession,
  getSession,
  resolveSession,
  resetSession,
  generateSessionName,
  ensureUniqueName,
  updateSessionName,
  expandHome,
} from "../router/index.js";
import { getAgent } from "../router/config.js";
import { spawnedAutomationEnv } from "../runtime/turn-origin.js";
import {
  dbDisableShellTriggerForOwner,
  dbListTriggers,
  dbGetTrigger,
  dbRecordTriggerFilterRejects,
  dbUpdateTriggerState,
} from "./triggers-db.js";
import {
  captureTriggerRunAuthority,
  sameTriggerDefinition,
  sessionAdmitsTriggerFire,
  triggerFireSession,
  triggerOwnerActsAsOperator,
  triggerRunsAs,
} from "./ownership.js";
import { isTriggerOwnSessionKey, triggerOwnSessionName } from "./authority.js";
import type { CompiledFilter } from "./filter.js";
import { isLegacySessionTarget, isSessionNameTemplate, type Trigger } from "./types.js";
import { resolveTemplate, resolveTemplateStrict } from "./template.js";
import { resolveTriggerActivation } from "./activation.js";
import { isInternalEventTopic } from "./topic-policy.js";
import { buildTriggerPrompt } from "./prompt.js";
import { TriggerDebouncer, type TriggerBatch } from "./debounce.js";
import { DEFAULT_CRON_SHELL_TIMEOUT_MS, runShellCronCommand, type ShellCronRunResult } from "../cron/shell-executor.js";
import { filterAgentRuntimeBaseEnv } from "../runtime/agent-env-policy.js";
import { type ShellEnvFileRefusal, shellEnvFileRefusal } from "./shell-env-file.js";

const log = logger.child("triggers:runner");
const EVENT_DEDUPE_TTL_MS = 60_000;
const EVENT_DEDUPE_MAX = 2_000;
const SESSION_NAME_MAX = 64;

/** Tracks a topic subscription stream for teardown */
type TopicSub = ReturnType<typeof nats.subscribe>;

interface PreparedTrigger {
  trigger: Trigger;
  filter: CompiledFilter;
}

interface TopicSubscription {
  stream: TopicSub;
  triggers: PreparedTrigger[];
  controller: AbortController;
  loop?: Promise<void>;
  failures: Error[];
}

interface PendingFilterRejects {
  count: number;
  lastRejectAt: number;
  topic: string;
  filter: string | undefined;
}

/** Filter rejects are batched so a busy topic costs one DB write per trigger per window. */
const FILTER_REJECT_FLUSH_MS = 5_000;
const MAX_LOGGED_EVENT_KEYS = 20;

/** Top-level field names only: enough to spot a filter path that the event never carries, no values. */
function eventKeysForLog(data: unknown): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  return Object.keys(data).slice(0, MAX_LOGGED_EVENT_KEYS);
}

export function planTriggerTopicRefresh(
  currentTopics: Iterable<string>,
  desiredTopics: Iterable<string>,
): { keep: string[]; add: string[]; remove: string[] } {
  const current = new Set(currentTopics);
  const desired = new Set(desiredTopics);
  return {
    keep: [...desired].filter((topic) => current.has(topic)).sort(),
    add: [...desired].filter((topic) => !current.has(topic)).sort(),
    remove: [...current].filter((topic) => !desired.has(topic)).sort(),
  };
}

/**
 * The channel an account delivers on: the channel of the instance that goes by
 * that name, as the rest of Ravi names channels (`whatsapp-baileys` is
 * `whatsapp`). `undefined` for an account no instance goes by: it names no channel.
 */
export function accountChannel(accountId: string): string | undefined {
  const instance = dbGetInstance(accountId);
  return instance ? canonicalChannelId(instance.channel) : undefined;
}

/**
 * The account an outbound source for a trigger turn goes out through.
 *
 * `source` already carries the account its chat was reached through: the one the
 * session last talked on, the one in a session key, the one frozen in the reply
 * source. The trigger's own `accountId` replaces it only when both hold:
 *
 * - It is a credential for the source's channel. The instance named for the
 *   account says which channel; one on another channel is the wrong provider's
 *   credential, so the source keeps its own. An account no instance goes by names
 *   no channel and is applied.
 * - It was set on its own (`--account`, the agent's account). An account equal to
 *   the frozen reply source's was taken from the creator's chat and says nothing
 *   about the chat this source reaches, which can sit in another workspace of the
 *   same channel: it replaces no account the source already carries.
 */
export function triggerSourceAccount(
  trigger: Pick<Trigger, "accountId" | "replySource">,
  source: { channel: string; accountId: string },
  channelOf: (accountId: string) => string | undefined = accountChannel,
): string {
  const own = trigger.accountId;
  if (!own) return source.accountId;
  const ownChannel = channelOf(own);
  if (ownChannel !== undefined && ownChannel !== canonicalChannelId(source.channel)) return source.accountId;
  const inherited = trigger.replySource?.accountId === own;
  return inherited && source.accountId ? source.accountId : own;
}

/**
 * Outbound source for a trigger turn, taken from where a session last talked.
 * `undefined` when the session has never had a chat to reply to. The account is
 * the session's own; whether the trigger's replaces it is `triggerSourceAccount`.
 */
export function sourceFromSessionEntry(
  session: { lastChannel?: string; lastAccountId?: string; lastTo?: string } | null | undefined,
): { channel: string; accountId: string; chatId: string } | undefined {
  if (!session?.lastChannel || !session.lastTo) return undefined;
  return {
    channel: session.lastChannel,
    accountId: session.lastAccountId ?? "",
    chatId: session.lastTo,
  };
}

export function isTriggerOriginatedEvent(topic: string, data: unknown): boolean {
  if (topic.includes(":trigger:")) return true;
  if (!data || typeof data !== "object") return false;
  const record = data as Record<string, unknown>;
  const origin = (record._turnProvenance as { origin?: unknown } | undefined)?.origin;
  if (origin === "trigger" || record._trigger === true) return true;
  // A command run by a turn in a trigger's own session: its audit event is
  // published under `ravi._cli.*` and names the session in the invocation
  // record. What such a turn does is not another trigger's to act on.
  const invocation = record.cliInvocation as { raviContext?: { sessionKey?: unknown } } | undefined;
  const invocationSession = invocation?.raviContext?.sessionKey;
  return typeof invocationSession === "string" && isTriggerOwnSessionKey(invocationSession);
}

export function shouldRetryTriggerTopic(
  topic: string,
  running: boolean,
  desiredTopics: ReadonlySet<string>,
  subscriptions: ReadonlyMap<string, unknown>,
): boolean {
  return running && desiredTopics.has(topic) && !subscriptions.has(topic);
}

/**
 * TriggerRunner - manages event-driven trigger subscriptions
 */
export class TriggerRunner {
  private publicationHealth: Subscription | null = null;

  /** Read the loaded subscription, not just a row that has not reached this runner. */
  publicationFollowHealth(triggerId?: string) {
    const loaded = [...this.topicSubs.values()]
      .flatMap((sub) => sub.triggers)
      .find(({ trigger }) => trigger.id === triggerId);
    return {
      running: this.running,
      producerRunning: getLocalWatchRunner().isRunning(),
      fingerprint: this.running && loaded ? followFingerprint(loaded.trigger) : null,
    };
  }

  private subscribePublicationHealth(): void {
    try {
      this.publicationHealth = getNats().subscribe(followHealthTopic(), {
        callback: (error, message) => {
          if (error || !message.reply || message.data.length > 512) return;
          try {
            const input = JSON.parse(new TextDecoder().decode(message.data)) as { triggerId?: unknown };
            if (
              input.triggerId !== undefined &&
              (typeof input.triggerId !== "string" || !/^[\w-]{1,100}$/.test(input.triggerId))
            )
              return;
            message.respond(
              Buffer.from(JSON.stringify(this.publicationFollowHealth(input.triggerId as string | undefined))),
            );
          } catch {
            /* Ignore malformed probes; no state is changed by this endpoint. */
          }
        },
      });
    } catch {
      log.warn("PR publication health endpoint is unavailable");
    }
  }
  /** Topic streams (NOT including refresh/test — those are long-lived) */
  private topicSubs = new Map<string, TopicSubscription>();
  /** Last desired topic set, used to prevent delayed retries from reviving removed subscriptions. */
  private desiredTopics = new Set<string>();
  private running = false;
  private recentEventFires = new Map<string, number>();
  /** Last fire per resolved session of named-session triggers (per-session cooldown). */
  private keyedLastFiredAt = new Map<string, { at: number; cooldownMs: number }>();
  private recentEventFireOps = 0;
  private pendingFilterRejects = new Map<string, PendingFilterRejects>();
  private filterRejectFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last topic+filter logged at info per trigger, so each filter logs its first reject once. */
  private loggedFilterRejects = new Map<string, string>();
  /** Pending bursts of debounced triggers, keyed like the cooldown (trigger or trigger+session). */
  private debouncer = new TriggerDebouncer((batch) => this.flushDebounced(batch));

  /**
   * Start the trigger runner.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Starting trigger runner");

    await this.setupSubscriptions();
    this.subscribePublicationHealth();
    this.subscribeToConfigRefresh();
    this.subscribeToTestEvents();

    log.info("Trigger runner started");
  }

  /**
   * Stop the trigger runner.
   */
  async stop(): Promise<void> {
    if (!this.running && !this.publicationHealth && !this.topicSubs.size && !this.pendingFilterRejects.size) return;
    this.running = false;
    const failures: Error[] = [];

    log.info("Stopping trigger runner");
    try {
      this.publicationHealth?.unsubscribe();
      this.publicationHealth = null;
    } catch (cause) {
      failures.push(new Error("Trigger publication health unsubscribe failed", { cause }));
    }

    failures.push(...(await this.teardownSubscriptions()));
    failures.push(...this.flushFilterRejects());
    try {
      const pendingDebounced = this.debouncer.clear();
      if (pendingDebounced > 0) {
        log.warn("Dropped debounced trigger events pending at stop", { events: pendingDebounced });
      }
    } catch (cause) {
      failures.push(new Error("Trigger debounce cleanup failed", { cause }));
    }
    if (failures.length) throw new AggregateError(failures, "Trigger runner shutdown failed", { cause: failures[0] });
    log.info("Trigger runner stopped");
  }

  /** Stop every topic before waiting; an idle next() must be woken before return(). */
  private async teardownSubscriptions(): Promise<Error[]> {
    this.desiredTopics.clear();
    const subscriptions = [...this.topicSubs.entries()];
    for (const [, subscription] of subscriptions) subscription.controller.abort();
    const results = await Promise.all(
      subscriptions.map(async ([topic, subscription]) => {
        try {
          await subscription.stream.return?.(undefined);
        } catch (cause) {
          subscription.failures.push(new Error(`Trigger topic ${topic} close failed`, { cause }));
        }
        await subscription.loop;
        if (subscription.failures.length === 0) this.topicSubs.delete(topic);
        return subscription.failures;
      }),
    );
    return results.flat();
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
    const triggers = dbListTriggers({ enabledOnly: true });

    // Group by topic to share subscriptions
    const byTopic = new Map<string, PreparedTrigger[]>();
    let skippedInvalidFilter = 0;
    let skippedUnboundAgent = 0;
    for (const t of triggers) {
      const activation = resolveTriggerActivation(t);
      if (activation.state === "blocked_topic") {
        log.warn("Skipping trigger on internal topic (anti-loop)", { topic: t.topic, triggerId: t.id });
        continue;
      }
      if (activation.state === "invalid_filter") {
        skippedInvalidFilter += 1;
        log.error("Skipping trigger with invalid filter (fail-closed); fix or clear the filter to activate it", {
          triggerId: t.id,
          triggerName: t.name,
          topic: t.topic,
          executionType: t.executionType ?? "agent",
          filter: t.filter,
          error: activation.filter.error,
        });
        continue;
      }
      if (activation.state === "unbound_agent") {
        skippedUnboundAgent += 1;
        log.error("Skipping trigger; bound agent is gone (unbound_agent). No session will be created.", {
          triggerId: t.id,
          triggerName: t.name,
          agentId: t.agentId,
          topic: t.topic,
          runtimeState: "unbound_agent",
        });
        continue;
      }
      const list = byTopic.get(t.topic) || [];
      list.push({ trigger: t, filter: activation.filter });
      byTopic.set(t.topic, list);
    }

    this.desiredTopics = new Set(byTopic.keys());
    const plan = planTriggerTopicRefresh(this.topicSubs.keys(), this.desiredTopics);
    for (const topic of plan.keep) {
      const existing = this.topicSubs.get(topic);
      const desired = byTopic.get(topic);
      if (!existing || !desired) continue;
      const previousById = new Map(existing.triggers.map((item) => [item.trigger.id, item.trigger]));
      for (const item of desired) {
        const previous = previousById.get(item.trigger.id);
        if (previous?.lastFiredAt && (!item.trigger.lastFiredAt || previous.lastFiredAt > item.trigger.lastFiredAt)) {
          item.trigger.lastFiredAt = previous.lastFiredAt;
        }
      }
      // The loop reads this mutable snapshot, so config changes do not churn
      // a healthy NATS subscription for the same topic.
      existing.triggers = desired;
    }

    for (const topic of plan.add) {
      const desired = byTopic.get(topic);
      if (desired) this.subscribeToTopic(topic, desired);
    }

    for (const topic of plan.remove) {
      const subscription = this.topicSubs.get(topic);
      if (!subscription) continue;
      this.topicSubs.delete(topic);
      try {
        subscription.stream.return?.(undefined);
      } catch {
        // Ignore close failures; the subscription is no longer reachable.
      }
    }

    log.info("Subscriptions set up", {
      topics: byTopic.size,
      triggers: triggers.length,
      skippedInvalidFilter,
      skippedUnboundAgent,
      addedTopics: plan.add.length,
      retainedTopics: plan.keep.length,
      removedTopics: plan.remove.length,
    });
  }

  /**
   * Subscribe to a NATS topic and fire matching triggers.
   */
  private subscribeToTopic(topic: string, triggers: PreparedTrigger[]): void {
    const controller = new AbortController();
    const stream = nats.subscribe(topic, { signal: controller.signal });
    const subscription: TopicSubscription = { stream, triggers, controller, failures: [] };
    this.topicSubs.set(topic, subscription);

    // Retain the loop so shutdown observes a rejection delivered to pending next().
    subscription.loop = (async () => {
      try {
        for await (const event of stream) {
          if (!this.running) break;
          // A refresh that removed this topic calls stream.return(), but an
          // async generator queues that behind the pending next(), so one more
          // event still lands here. Drop it instead of firing stale triggers.
          if (this.topicSubs.get(topic) !== subscription) break;

          // Skip events from trigger sessions (prevents self-fire loops)
          // Trigger sessions use pattern: ravi.agent:{id}:trigger:{triggerId}.*
          // Prefer canonical turn provenance; retain legacy topic/marker checks
          // for producers that have not adopted it yet.
          const eventData = event.data as Record<string, unknown> | undefined;
          if (isTriggerOriginatedEvent(event.topic, eventData)) continue;
          // A wildcard pattern also delivers the bus's own transport (what a
          // session streams, a request's reply, a remote worker's pipe).
          if (isInternalEventTopic(event.topic)) continue;

          for (const prepared of subscription.triggers) {
            const trigger = prepared.trigger;
            // Named-session triggers cool down per resolved session: one busy
            // session must not swallow events that belong to another.
            let keyedCooldownKey: string | null = null;
            if (!isLegacySessionTarget(trigger.session)) {
              const targetName = resolveSessionTargetName(trigger.session, event);
              if (!targetName) {
                // Skip before touching cooldown, so every unresolved event
                // is logged and none holds back a resolvable one.
                log.warn("Skipping trigger fire; session name template did not resolve", {
                  triggerId: trigger.id,
                  triggerName: trigger.name,
                  topic: event.topic,
                  session: trigger.session,
                });
                continue;
              }
              keyedCooldownKey = keyedCooldownId(trigger, targetName);
            }
            const debounceMs = trigger.debounceMs ?? 0;
            const debounced = debounceMs > 0;
            const lastFiredAt = keyedCooldownKey
              ? this.keyedLastFiredAt.get(keyedCooldownKey)?.at
              : trigger.lastFiredAt;
            // Cooldown check. A debounced trigger checks it when the burst
            // fires instead, and waits it out rather than dropping events.
            if (!debounced && lastFiredAt && Date.now() - lastFiredAt < trigger.cooldownMs) {
              log.debug("Trigger cooldown active, skipping", {
                triggerId: trigger.id,
                triggerName: trigger.name,
              });
              continue;
            }

            // Filter check: evaluate trigger's filter expression against event data
            if (!prepared.filter.evaluate(event.data)) {
              this.recordFilterReject(trigger, event);
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

            if (debounced) {
              this.debouncer.add(keyedCooldownKey ?? trigger.id, trigger.id, debounceMs, event);
              continue;
            }

            // Set cooldown immediately to prevent race condition:
            // Without this, multiple events arriving in rapid succession
            // all pass the cooldown check before the first fireTrigger
            // completes and updates lastFiredAt.
            if (keyedCooldownKey) this.markKeyedFire(keyedCooldownKey, trigger.cooldownMs);
            else trigger.lastFiredAt = Date.now();

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
        if (!this.running || this.topicSubs.get(topic) !== subscription) {
          subscription.failures.push(new Error(`Trigger topic ${topic} failed during shutdown`, { cause: err }));
          return;
        }

        log.error("Topic subscription error", { topic, error: err });
        this.topicSubs.delete(topic);
        // Retry after delay
        setTimeout(() => {
          if (shouldRetryTriggerTopic(topic, this.running, this.desiredTopics, this.topicSubs)) {
            this.subscribeToTopic(topic, subscription.triggers);
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
   * A debounced burst is due. It fires with its last event and the whole batch,
   * using the trigger as currently configured; a cooldown still running delays
   * the burst instead of dropping it.
   */
  private flushDebounced(batch: TriggerBatch): void {
    const trigger = this.findLiveTrigger(batch.triggerId);
    if (!trigger || !this.running) {
      log.info("Dropping debounced burst; trigger is gone or disabled", {
        triggerId: batch.triggerId,
        events: batch.events.length,
      });
      return;
    }
    const keyed = batch.key !== trigger.id;
    const lastFiredAt = keyed ? this.keyedLastFiredAt.get(batch.key)?.at : trigger.lastFiredAt;
    const remaining = lastFiredAt ? trigger.cooldownMs - (Date.now() - lastFiredAt) : 0;
    if (remaining > 0) {
      log.debug("Debounced burst waiting for cooldown", { triggerId: trigger.id, remainingMs: remaining });
      this.debouncer.requeue(batch, remaining);
      return;
    }
    if (keyed) this.markKeyedFire(batch.key, trigger.cooldownMs);
    else trigger.lastFiredAt = Date.now();

    const last = batch.events[batch.events.length - 1];
    if (!last) return;
    log.info("Firing debounced trigger", {
      triggerId: trigger.id,
      triggerName: trigger.name,
      events: batch.events.length,
      omitted: batch.omitted,
    });
    this.fireTrigger(trigger, last, { batch }).catch((err) => {
      log.error("Error firing trigger", { triggerId: trigger.id, error: err });
    });
  }

  private findLiveTrigger(id: string): Trigger | null {
    for (const subscription of this.topicSubs.values()) {
      const prepared = subscription.triggers.find((item) => item.trigger.id === id);
      if (prepared) return prepared.trigger.enabled ? prepared.trigger : null;
    }
    return null;
  }

  private markKeyedFire(key: string, cooldownMs: number): void {
    const now = Date.now();
    this.keyedLastFiredAt.set(key, { at: now, cooldownMs });
    if (this.keyedLastFiredAt.size > EVENT_DEDUPE_MAX) {
      // Each entry expires on its own trigger's cooldown, so pruning for one
      // trigger never shortens another's.
      for (const [candidate, entry] of this.keyedLastFiredAt) {
        if (now - entry.at >= entry.cooldownMs) this.keyedLastFiredAt.delete(candidate);
      }
    }
  }

  /**
   * Fire a trigger with event data.
   */
  private async fireTrigger(
    trigger: Trigger,
    event: { topic: string; data: unknown },
    opts: { test?: boolean; batch?: TriggerBatch; testInitiator?: string } = {},
  ): Promise<void> {
    const agentId = trigger.agentId ?? getDefaultAgentId();
    const agent = getAgent(agentId);
    if (!agent) {
      log.error("Skipping trigger fire; bound agent is gone (unbound_agent). No session will be created.", {
        triggerId: trigger.id,
        triggerName: trigger.name,
        agentId,
        topic: event.topic,
        runtimeState: "unbound_agent",
      });
      return;
    }
    const agentCwd = expandHome(agent.cwd);

    let sessionName: string;
    let source: { channel: string; accountId: string; chatId: string } | undefined;
    // The trigger as stored now: who owns it decides which session is its own.
    const stored = dbGetTrigger(trigger.id);
    // Whether this fire is its owner's: decided before the session is chosen,
    // because only such a fire enters the trigger's own session.
    const ownerFire = this.fireIsOwners(trigger, stored, opts);
    // The key of the trigger's own session, when this fire runs there. Only an
    // `isolated` trigger a person owns has one; nothing else enters it.
    let ownSessionKey: string | null = null;

    if (trigger.session === "main") {
      // If replySession is set, resolve it for session name + source routing
      if (trigger.replySession) {
        const resolved = resolveSession(trigger.replySession);
        // Another trigger's own session never stands in for the main session.
        if (resolved?.name && sessionAdmitsTriggerFire(resolved)) {
          sessionName = resolved.name;
          source = sourceFromSessionEntry(resolved);
        } else {
          // Fallback: derive source from session key and use main session
          source = deriveSourceFromSessionKey(trigger.replySession) ?? undefined;
          sessionName = this.resolveMainSessionName(agentId, agentCwd);
        }
      } else {
        // No reply override: the turn runs in the agent main session. A
        // creator-time `replySource` stays the pinned recipient (applied
        // below); only without one does the turn reply where the main session
        // last talked, the routing an explicit `--reply-session <main>` gives.
        // Without either the turn was source-less and its reply could be
        // dropped by the gateway (2a728cd4).
        sessionName = this.resolveMainSessionName(agentId, agentCwd);
        if (!trigger.replySource) {
          source = sourceFromSessionEntry(resolveSession(sessionName));
        }
      }
    } else if (trigger.session === "isolated") {
      // A trigger a person owns runs in its own session; one nobody owns keeps
      // the plain one-per-trigger session, as before owners existed. A fire
      // that is not its owner's (someone else's test, a stale definition)
      // runs in the plain session too: it never touches the owner's history.
      const target = triggerFireSession(agentId, stored ?? trigger, { asOwner: ownerFire });
      const dbKey = target.sessionKey;
      // The own session is found by its key alone: a session that merely goes
      // by that string as its name is not it.
      const existing = target.own ? getSession(dbKey) : resolveSession(dbKey);
      if (target.own) ownSessionKey = dbKey;
      if (target.own) {
        // The own session goes by one name, its key: a name the session store
        // gives to no other session, before this one exists or after it is
        // deleted. So nothing keyed to its name (history, a context, a signal)
        // was ever another session's, and nobody inherits what this one stored.
        sessionName = triggerOwnSessionName(dbKey);
        if (!existing) getOrCreateSession(dbKey, agentId, agentCwd, { name: sessionName }, { triggerRunner: true });
        // Start after whatever the journal already holds under that name (an
        // earlier own session of this trigger, since deleted). Checked on
        // every fire, so a session left without the mark gets it before its
        // first turn.
        if (existing?.historyResetAfterId === undefined) resetSession(dbKey);
      } else if (existing?.name) {
        sessionName = existing.name;
      } else {
        const baseName = generateSessionName(agentId, { suffix: `trigger-${trigger.name}` });
        sessionName = ensureUniqueName(baseName);
        const session = getOrCreateSession(dbKey, agentId, agentCwd, { name: sessionName }, { triggerRunner: true });
        if (!session.name) updateSessionName(session.sessionKey, sessionName);
      }

      // Derive source from replySession for isolated sessions too
      if (trigger.replySession) {
        source =
          sourceFromSessionEntry(resolveSession(trigger.replySession)) ??
          deriveSourceFromSessionKey(trigger.replySession) ??
          undefined;
      }
    } else {
      const targetName = opts.test
        ? resolveSessionTargetName(trigger.session, event, { fillUnresolved: "test" })
        : resolveSessionTargetName(trigger.session, event);
      if (!targetName) {
        // Never fall back to a shared session: an unresolved name would mix
        // events that belong to different sessions.
        log.warn("Skipping trigger fire; session name template did not resolve", {
          triggerId: trigger.id,
          triggerName: trigger.name,
          topic: event.topic,
          session: trigger.session,
        });
        return;
      }
      // An existing session with that name is the target as is (the agent
      // that owns it runs the turn); otherwise create it for this trigger.
      const dbKey = `agent:${agentId}:trigger:${trigger.id}:key:${createHash("sha256").update(targetName).digest("hex").slice(0, 24)}`;
      // The raw value first, so a session key or a name outside the
      // normalized form still finds its session.
      const rawTarget = resolveTemplate(trigger.session, event).trim();
      const existing = resolveSession(rawTarget) ?? resolveSession(targetName) ?? resolveSession(dbKey);
      if (existing && existing.agentId !== agentId && isSessionNameTemplate(trigger.session)) {
        // A name built from event data must not reach into another agent's
        // session; only a literal name chosen at creation may do that.
        log.warn("Skipping trigger fire; resolved session belongs to another agent", {
          triggerId: trigger.id,
          triggerName: trigger.name,
          topic: event.topic,
          session: existing.name ?? existing.sessionKey,
        });
        return;
      }
      if (isTriggerOwnSessionKey(rawTarget) || (existing && !sessionAdmitsTriggerFire(existing))) {
        // A trigger's own session is entered only by that trigger's isolated
        // fires: a name, a key or event data never points another fire there,
        // nor at a stand-in for one that does not exist yet.
        log.warn("Skipping trigger fire; resolved session is another trigger's own", {
          triggerId: trigger.id,
          triggerName: trigger.name,
          topic: event.topic,
          session: existing?.name ?? existing?.sessionKey ?? rawTarget,
        });
        return;
      }
      if (existing) {
        // An unnamed session (e.g. the creator's, inherited by key) is reused
        // and given a name, never replaced by a new one.
        sessionName = existing.name ?? ensureUniqueName(targetName);
        if (!existing.name) updateSessionName(existing.sessionKey, sessionName);
      } else {
        sessionName = ensureUniqueName(targetName);
        const session = getOrCreateSession(dbKey, agentId, agentCwd, { name: sessionName }, { triggerRunner: true });
        if (!session.name) updateSessionName(session.sessionKey, sessionName);
      }

      if (trigger.replySession) {
        source =
          sourceFromSessionEntry(resolveSession(trigger.replySession)) ??
          deriveSourceFromSessionKey(trigger.replySession) ??
          undefined;
      } else if (!trigger.replySource) {
        // Like main-session triggers (2a728cd4): reply where the target
        // session last talked, unless a creator-time recipient is pinned.
        source = sourceFromSessionEntry(existing);
      }
    }

    // Final fallback: the source the creator was talking to when the trigger
    // was registered. Frozen at creation time, immune to later session edits.
    if (!source && trigger.replySource) {
      source = {
        channel: trigger.replySource.channel,
        accountId: trigger.replySource.accountId,
        chatId: trigger.replySource.chatId,
      };
    }

    // The trigger's own account replaces the one the source carries only where
    // it is meant to: on its own channel, and when it was not taken from the
    // creator's chat. Every path above ends here, so one rule covers them all.
    if (source && trigger.accountId) source.accountId = triggerSourceAccount(trigger, source);

    if ((trigger.executionType ?? "agent") === "shell") {
      await this.fireShellTrigger(trigger, event, source, opts.batch, { stored, ownerFire });
      return;
    }

    const prompt = buildTriggerPrompt(trigger, event, opts.batch);

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
      _triggerAuthority: captureTriggerRunAuthority(ownerFire && stored ? stored : { id: trigger.id }, {
        ownSessionKey,
      }),
    });

    dbUpdateTriggerState(trigger.id, {
      lastFiredAt: Date.now(),
      incrementFire: true,
    });

    // Update in-memory trigger too (for cooldown tracking)
    trigger.lastFiredAt = Date.now();
  }

  /**
   * Whether this fire is its owner's, fixed now: it decides both who the fire
   * acts as (the snapshot carried with the prompt) and which session it runs
   * in. The owner is read from the stored row, never from the subscription's
   * copy, and is admitted only when that row is still the trigger being
   * fired: after an edit the runner has not reloaded, the old message must
   * not run under the row's owner, and a row that is gone has no owner. A
   * test fire is admitted only for the owner's own test. A fire that is not
   * admitted acts as nobody and stays out of the trigger's own session.
   */
  private fireIsOwners(
    trigger: Trigger,
    stored: Trigger | null,
    opts: { test?: boolean; testInitiator?: string },
  ): boolean {
    return (
      stored !== null &&
      sameTriggerDefinition(stored, trigger) &&
      (!opts.test || (opts.testInitiator !== undefined && opts.testInitiator === triggerRunsAs(stored)))
    );
  }

  /**
   * A filter that never matches used to be visible only at debug level, leaving
   * `fireCount 0` with no trace. Count every reject for `ravi triggers show` and
   * log the first one per filter at info with the event's top-level keys.
   */
  private recordFilterReject(trigger: Trigger, event: { topic: string; data: unknown }): void {
    const now = Date.now();
    const pending = this.pendingFilterRejects.get(trigger.id);
    if (pending && pending.topic === trigger.topic && pending.filter === trigger.filter) {
      pending.count += 1;
      pending.lastRejectAt = now;
    } else {
      if (pending) this.flushFilterRejects();
      this.pendingFilterRejects.set(trigger.id, {
        count: 1,
        lastRejectAt: now,
        topic: trigger.topic,
        filter: trigger.filter,
      });
    }

    const logKey = `${trigger.topic}\0${trigger.filter ?? ""}`;
    if (this.loggedFilterRejects.get(trigger.id) !== logKey) {
      this.loggedFilterRejects.set(trigger.id, logKey);
      log.info("Trigger filter rejected an event; later rejects are counted in `ravi triggers show`", {
        triggerId: trigger.id,
        triggerName: trigger.name,
        topic: event.topic,
        // The filter literal can carry chat ids or phone numbers; `ravi triggers show` has it.
        eventKeys: eventKeysForLog(event.data),
      });
    } else {
      log.debug("Trigger filter did not match, skipping", {
        triggerId: trigger.id,
        triggerName: trigger.name,
        filter: trigger.filter,
      });
    }

    this.scheduleFilterRejectFlush();
  }

  private scheduleFilterRejectFlush(): void {
    if (this.filterRejectFlushTimer) return;
    this.filterRejectFlushTimer = setTimeout(() => {
      this.filterRejectFlushTimer = null;
      this.flushFilterRejects();
    }, FILTER_REJECT_FLUSH_MS);
    this.filterRejectFlushTimer.unref?.();
  }

  private flushFilterRejects(): Error[] {
    const failures: Error[] = [];
    if (this.filterRejectFlushTimer) {
      clearTimeout(this.filterRejectFlushTimer);
      this.filterRejectFlushTimer = null;
    }
    const batch = [...this.pendingFilterRejects.entries()];
    this.pendingFilterRejects.clear();
    for (const [triggerId, rejects] of batch) {
      try {
        dbRecordTriggerFilterRejects(triggerId, rejects);
      } catch (error) {
        log.warn("Failed to record trigger filter rejects; retrying on the next flush", { triggerId, error });
        this.restoreFilterRejects(triggerId, rejects);
        failures.push(new Error(`Trigger ${triggerId} filter reject flush failed`, { cause: error }));
      }
    }
    return failures;
  }

  /** Put a failed batch back. A newer batch for another topic/filter wins; the stale one is dropped. */
  private restoreFilterRejects(triggerId: string, rejects: PendingFilterRejects): void {
    const newer = this.pendingFilterRejects.get(triggerId);
    if (!newer) {
      this.pendingFilterRejects.set(triggerId, rejects);
    } else if (newer.topic === rejects.topic && newer.filter === rejects.filter) {
      newer.count += rejects.count;
      newer.lastRejectAt = Math.max(newer.lastRejectAt, rejects.lastRejectAt);
    }
    if (this.running) this.scheduleFilterRejectFlush();
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
      // The command acts for this trigger, never as the operator's terminal.
      ...spawnedAutomationEnv("trigger", trigger.id),
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
    // A trigger's own session runs that trigger's fires only: a failed
    // command's output is not one, so it is reported nowhere rather than there.
    if (!sessionAdmitsTriggerFire(resolved) || isTriggerOwnSessionKey(sessionRef)) {
      log.warn("Skipping trigger on-error notice; the session is a trigger's own", {
        triggerId: trigger.id,
        session: sessionRef,
      });
      return;
    }
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

  /**
   * A shell trigger whose owner does not act as the operator never runs. It is
   * turned off once, with one notice to the main session; later events find it
   * off. The notice never carries the command, its env or any event data.
   */
  private refuseShellTriggerOwner(trigger: Trigger): void {
    this.turnOffRefusedShellTrigger(
      trigger,
      "TRIGGER_SHELL_NOT_OPERATOR",
      `It runs as ${triggerRunsAs(trigger)}, not the operator, and a shell command runs with this machine's access.`,
      "The operator can recreate it from their own chat with Ravi and remove this one.",
    );
  }

  /**
   * A shell trigger whose env file is refused never runs either: turned off
   * once, one notice to the main session (its owner is the operator). The
   * notice names the reason, never the file's content or the command.
   */
  private refuseShellTriggerEnvFile(trigger: Trigger, reason: ShellEnvFileRefusal): void {
    const codes: Record<ShellEnvFileRefusal, string> = {
      in_state_dir: "TRIGGER_SHELL_ENV_FILE_IN_STATE_DIR",
      not_regular_file: "TRIGGER_SHELL_ENV_FILE_NOT_REGULAR",
      hard_link: "TRIGGER_SHELL_ENV_FILE_HARD_LINK",
      too_large: "TRIGGER_SHELL_ENV_FILE_TOO_LARGE",
    };
    const why: Record<ShellEnvFileRefusal, string> = {
      in_state_dir:
        "Its env file is inside the Ravi state dir, which holds the daemon's own secrets, or its path has a .. segment.",
      not_regular_file: "Its env file is not a regular file (a FIFO, a device or a directory).",
      hard_link: "Its env file has more than one hard link, so its content may be a file inside the Ravi state dir.",
      too_large: "Its env file is larger than 1 MiB, the most the env-file loader reads.",
    };
    this.turnOffRefusedShellTrigger(
      trigger,
      codes[reason],
      why[reason],
      `Give it a regular file of its own outside the Ravi state dir (ravi triggers set ${trigger.id} env-file <path>) and turn it back on (ravi triggers enable ${trigger.id}), from the owner's chat with Ravi.`,
    );
  }

  private turnOffRefusedShellTrigger(trigger: Trigger, code: string, why: string, next: string): void {
    log.error("Shell trigger not run: refused", { triggerId: trigger.id, triggerName: trigger.name, code });
    if (!dbDisableShellTriggerForOwner(trigger)) return;
    trigger.enabled = false;
    // Drop the copy this runner holds, so later events stop reaching it.
    void nats.emit("ravi.triggers.refresh", {}).catch((error) => {
      log.warn("Failed to request a trigger refresh after turning off a shell trigger", {
        triggerId: trigger.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const agentId = getDefaultAgentId();
    const sessionName = getMainSession(agentId)?.name ?? agentId;
    void publishSessionPrompt(sessionName, {
      prompt: `[System] Inform: [from: trigger:${trigger.id}] Shell trigger disabled (${code}). ${why} No command was executed. Inspect with ravi triggers show ${trigger.id}. ${next}`,
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
    }).catch((error) => {
      log.error("Failed to publish shell trigger refusal notice; trigger remains disabled", {
        triggerId: trigger.id,
        code,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async fireShellTrigger(
    trigger: Trigger,
    event: { topic: string; data: unknown },
    source: { channel: string; accountId: string; chatId: string } | undefined,
    batch: TriggerBatch | undefined,
    current: { stored: Trigger | null; ownerFire: boolean },
  ): Promise<void> {
    // The trigger as stored now decides, never the copy the runner loaded. A
    // change to what `sameTriggerDefinition` compares (topic, filter, enabled,
    // execution type, ...) or a deleted row skips this fire, and the refresh
    // reloads the trigger. Everything this fire runs comes from the stored row:
    // its owner, command, env file and timeout.
    if (!current.ownerFire || !current.stored) {
      log.warn("Skipping shell trigger fire: its stored definition changed or is gone", { triggerId: trigger.id });
      return;
    }
    const stored = current.stored;
    if (!stored.shellCommand?.trim()) {
      throw new Error("Shell trigger is missing shellCommand");
    }
    // Same rule as shell cron jobs: a shell command runs with this machine's
    // access, so it runs only when its current owner acts as the operator.
    if (!triggerOwnerActsAsOperator(stored.ownerPrincipal)) {
      this.refuseShellTriggerOwner(stored);
      return;
    }
    // The env file is what the command gets on purpose. One inside the Ravi
    // state dir (the daemon's own `.env`, for example), or a hard link that may
    // be one, would hand it every secret. Checked again here because the file
    // can change after the trigger was saved.
    const envFileRefusal = stored.shellEnvFile ? shellEnvFileRefusal(stored.shellEnvFile) : null;
    if (envFileRefusal) {
      this.refuseShellTriggerEnvFile(stored, envFileRefusal);
      return;
    }

    const firedAt = Date.now();
    const tempDir = await mkdtemp(join(tmpdir(), "ravi-trigger-shell-"));
    const eventFile = join(tempDir, "event.json");
    const dataFile = join(tempDir, "data.json");
    // Every event this fire carries: one, or the whole debounced burst (oldest first).
    const eventsFile = join(tempDir, "events.json");
    const events = batch?.events ?? [event];

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
      await writeFile(eventsFile, JSON.stringify(events, null, 2), "utf8");

      log.info("Firing shell trigger", {
        triggerId: trigger.id,
        triggerName: trigger.name,
        topic: event.topic,
        hasSource: !!source,
      });

      const result = await runShellCronCommand(stored.shellCommand, {
        timeoutMs: stored.shellTimeoutMs ?? DEFAULT_CRON_SHELL_TIMEOUT_MS,
        // An event decides when this runs, so the command starts from the
        // allowlisted agent env, never the daemon's secrets. What the command
        // needs on purpose comes from its env file.
        baseEnv: filterAgentRuntimeBaseEnv(process.env),
        envFile: stored.shellEnvFile,
        env: {
          ...this.buildShellEnv(trigger, event, source, eventFile, dataFile),
          RAVI_TRIGGER_EVENTS_FILE: eventsFile,
          RAVI_TRIGGER_EVENT_COUNT: String(events.length + (batch?.omitted ?? 0)),
        },
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
          await this.notifyShellTriggerError(stored, result, errorMessage);
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

        const data = event.data as { triggerId?: string; initiator?: unknown };
        if (!data.triggerId) continue;

        log.info("Received test trigger", { triggerId: data.triggerId });

        const trigger = dbGetTrigger(data.triggerId);
        if (!trigger) {
          log.warn("Trigger not found for test", { triggerId: data.triggerId });
          continue;
        }

        await this.fireTrigger(
          trigger,
          {
            topic: trigger.topic,
            data: {
              _test: true,
              message: "Test event fired via CLI",
              timestamp: new Date().toISOString(),
            },
          },
          // Who asked for the test: the fire acts as the trigger's owner only when they are that owner.
          { test: true, ...(typeof data.initiator === "string" ? { testInitiator: data.initiator } : {}) },
        );
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

/** Per-session cooldown id for a named-session trigger. */
function keyedCooldownId(trigger: Trigger, sessionName: string): string {
  return `${trigger.id}\u0000${sessionName}`;
}

/**
 * The session name a trigger targets for one event: its `session` template
 * resolved against the event and normalized to a session name (lowercase,
 * alphanumerics and hyphens, max 64; longer names end in a hash of the
 * whole name), or null when a placeholder did not
 * resolve to a non-empty value (missing, null, empty) or nothing is left.
 * `fillUnresolved` replaces those placeholders instead (`ravi triggers test`).
 */
export function resolveSessionTargetName(
  session: string,
  event: { topic: string; data: unknown },
  opts: { fillUnresolved?: string } = {},
): string | null {
  let resolved = resolveTemplateStrict(session, event);
  if (resolved === null) {
    if (opts.fillUnresolved === undefined) return null;
    const fill = opts.fillUnresolved;
    resolved = session.replace(/\{\{([^}]+)\}\}/g, (match) => resolveTemplateStrict(match, event) ?? fill);
  }
  const name = resolved
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (name.length <= SESSION_NAME_MAX) return name || null;
  // Keep long names that share a prefix apart: a hash of the whole name
  // replaces the tail.
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, SESSION_NAME_MAX - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

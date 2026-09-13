import { getContext } from "../cli/context.js";
import { getAccountForAgent } from "../router/router-db.js";
import { dbCreateTrigger, dbListTriggers, type Trigger, type TriggerInput } from "../triggers/index.js";
import { evaluateFilter } from "../triggers/filter.js";
import type { TriggerReplySource } from "../triggers/types.js";

/**
 * Console push delivery eventType is `watch.console.bug.status`.
 * The local delivery bridge republishes that as a normalized watch subject:
 * `ravi.watch.<connector>.<event-type>` → `ravi.watch.console.bug.status`.
 */
export const BUG_STATUS_WATCH_TOPIC = "ravi.watch.console.bug.status";
export const BUG_FOLLOW_COOLDOWN_MS = 30_000;
export const BUG_FOLLOW_TRIGGER_MESSAGE =
  "Bug status changed. Tell the user the new status, title, and consoleUrl from this event.";

export interface BugFollowContext {
  agentId?: string;
  accountId?: string;
  sessionName?: string;
  sessionKey?: string;
  source?: TriggerReplySource;
}

export interface BugReportFollowResult {
  ok: boolean;
  subscribed: boolean;
  triggerId?: string;
  reused?: boolean;
  topic: string;
  filter: string;
  session: "main";
  warning?: string;
}

export interface BugFollowTriggerDeps {
  createTrigger?: (input: TriggerInput) => Trigger;
  listTriggers?: () => Trigger[];
  emitTriggersRefresh?: () => Promise<void>;
  getFollowContext?: () => BugFollowContext | undefined;
  resolveAccountForAgent?: (agentId: string) => string | undefined;
}

export function bugReportSubscribeApiPath(bugId: string): string {
  const id = bugId.trim();
  return `/api/cli/bugs/${encodeURIComponent(id)}/subscribe`;
}

export function bugFollowTriggerName(bugId: string): string {
  return `bug-follow:${bugId}`;
}

export function bugFollowFilter(bugId: string): string {
  const quoted = JSON.stringify(bugId);
  // Normalized watch payloads keep connector fields under `payload`.
  // Console may also flatten `bugId` onto the event data root.
  return `data.payload.bugId == ${quoted} || data.bugId == ${quoted}`;
}

export function bugFollowMatchesEvent(bugId: string, data: unknown): boolean {
  return evaluateFilter(bugFollowFilter(bugId), data);
}

export function buildBugFollowTriggerInput(bugId: string, context: BugFollowContext = {}): TriggerInput {
  return {
    name: bugFollowTriggerName(bugId),
    topic: BUG_STATUS_WATCH_TOPIC,
    message: BUG_FOLLOW_TRIGGER_MESSAGE,
    agentId: context.agentId,
    accountId: context.accountId ?? context.source?.accountId,
    replySession: context.sessionName ?? context.sessionKey,
    replySource: context.source,
    session: "main",
    cooldownMs: BUG_FOLLOW_COOLDOWN_MS,
    filter: bugFollowFilter(bugId),
  };
}

export function findExistingBugFollowTrigger(bugId: string, triggers: Trigger[]): Trigger | undefined {
  const name = bugFollowTriggerName(bugId);
  const filter = bugFollowFilter(bugId);
  return triggers.find((trigger) => trigger.name === name || trigger.filter === filter);
}

export async function ensureBugFollowTrigger(
  bugId: string,
  deps: BugFollowTriggerDeps = {},
): Promise<{ trigger: Trigger; reused: boolean }> {
  const listTriggers = deps.listTriggers ?? dbListTriggers;
  const createTrigger = deps.createTrigger ?? dbCreateTrigger;
  const existing = findExistingBugFollowTrigger(bugId, listTriggers());
  if (existing) return { trigger: existing, reused: true };

  const context = resolveFollowContext(deps);
  if (!context.accountId && context.agentId) {
    try {
      context.accountId = (deps.resolveAccountForAgent ?? getAccountForAgent)(context.agentId);
    } catch {
      // Account lookup is optional; trigger fire-time resolution still works.
    }
  }
  const input = buildBugFollowTriggerInput(bugId, context);

  const trigger = createTrigger(input);
  try {
    await (deps.emitTriggersRefresh ?? defaultEmitTriggersRefresh)();
  } catch {
    // Trigger is durable; the daemon reloads on next refresh/restart.
  }
  return { trigger, reused: false };
}

function resolveFollowContext(deps: BugFollowTriggerDeps): BugFollowContext {
  if (deps.getFollowContext) return deps.getFollowContext() ?? {};
  const ctx = getContext();
  if (!ctx) return {};
  const source =
    ctx.source?.channel && ctx.source.accountId && ctx.source.chatId
      ? {
          channel: ctx.source.channel,
          accountId: ctx.source.accountId,
          chatId: ctx.source.chatId,
          ...(ctx.source.threadId ? { threadId: ctx.source.threadId } : {}),
        }
      : undefined;
  return {
    agentId: ctx.agentId,
    accountId: ctx.source?.accountId,
    sessionName: ctx.sessionName,
    sessionKey: ctx.sessionKey,
    source,
  };
}

async function defaultEmitTriggersRefresh(): Promise<void> {
  const { nats } = await import("../nats.js");
  await nats.emit("ravi.triggers.refresh", {});
}

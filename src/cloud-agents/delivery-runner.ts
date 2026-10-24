/**
 * Cloud run events into the chat that started the run (contract F1 "Console
 * -> OSS inbox events", F3 "Thread = run").
 *
 * The Console sends this installation inbox items of category `cloud_agents`
 * whose `payload.delivery` is `{ kind: "session", sessionName }`. The inbox
 * runner hands each new one to `acceptCloudInboxItem`, which records it once
 * (by item id) before the inbox item is acknowledged; the runner below works
 * the records off in the daemon, with retries:
 *
 * - `run.result`: the session gets an inform with the result, the outputs and
 *   the cost line, then `POST runs/<id>/delivered { kind: "result" }`.
 * - `approval.requested`: the session is told who decides; on Slack the run's
 *   person gets a private Approve/Deny card, elsewhere they reply
 *   `aprovar <código>` / `negar <código>` (chat-routing.ts).
 * - `question.asked`: the session asks the person, who answers through
 *   `ravi cloud runs answer` (or by replying in a bound thread).
 * - `delivery.message`: posted into the session's chat through the gateway's
 *   normal outbound path; never a new conversation, and on WhatsApp only where
 *   a person already wrote.
 * - `run.thread`: the bound thread's run card shows the new status; the
 *   binding ends with the run.
 *
 * Task runs (`ravi tasks dispatch --cloud`) keep the task watcher for their
 * result and approvals, so those two are skipped here. The Console decides
 * who receives what; this side only renders and acknowledges.
 */

import { isCloudAuthError } from "../cloud-auth/errors.js";
import type { InboxNatsPayload } from "../inbox/types.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { resolveSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";
import {
  buildCloudApprovalInform,
  buildCloudApprovalSlackCard,
  buildCloudQuestionInform,
  buildCloudResultInform,
  type CloudApprovalInformInput,
} from "./chat-copy.js";
import {
  type CloudDeliveryItem,
  type CloudThreadRun,
  cloudApprovalCode,
  dbClaimCloudDeliveryItem,
  dbCloseCloudChatRun,
  dbEndCloudThreadRuns,
  dbFinishCloudDeliveryItem,
  dbListCloudThreadsForRun,
  dbListDueCloudDeliveryItems,
  dbMarkCloudDeliveryItemInformed,
  dbRecordCloudChatApproval,
  dbRecordCloudChatQuestion,
  dbRecordCloudDeliveryItem,
  dbRetryCloudDeliveryItem,
  dbUpdateCloudThreadRun,
} from "./chat-db.js";
import {
  contactName as defaultContactName,
  resolveRunActorContact,
  slackUserIdsForContact as defaultSlackUserIdsForContact,
} from "./chat-people.js";
import {
  type CloudChatDeliveryReply,
  type CloudChatTarget,
  chatFromDelivery,
  deliverToChat as defaultDeliverToChat,
  normalizeChatChannel,
  personWroteFirst as defaultPersonWroteFirst,
  resolveSessionChat as defaultResolveSessionChat,
} from "./chat-target.js";
import {
  type CloudAgentsSession,
  type CloudAgentsSessionOptions,
  normalizeDelivery,
  numberOr,
  numberOrNull,
  objectValue,
  openCloudAgentsSession,
  stringArray,
  stringOrNull,
} from "./client.js";
import { dbGetCloudTaskRun } from "./task-runs-db.js";
import { updateCloudRunCard } from "./thread-binding.js";
import {
  CLOUD_INBOX_CATEGORY,
  type CloudDeliveryEventType,
  isCloudDeliveryEventType,
  isTerminalCloudRunStatus,
} from "./types.js";

const log = logger.child("cloud-agents:delivery");

export const CLOUD_DELIVERY_INTERVAL_MS = 30_000;
/** Attempts before an item is given up (`failed`). */
export const CLOUD_DELIVERY_MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const BATCH = 25;
const MESSAGE_MAX_CHARS = 4_000;

export interface CloudDeliveryRunnerDeps {
  intervalMs?: number;
  now?: () => number;
  openSession?: (options: CloudAgentsSessionOptions) => Promise<CloudAgentsSession | null>;
  /** The session's own name when it exists here, else null. */
  resolveSessionName?: (sessionName: string) => string | null;
  /**
   * Hands a `[System] Inform` to a session; `messageId` collapses a retried publish. `source` is the run's
   * chat, so the reply goes there even when the session has since talked in another chat.
   */
  informSession?: (
    sessionName: string,
    prompt: string,
    messageId: string,
    source: CloudChatTarget | null,
  ) => Promise<void>;
  resolveSessionChat?: (sessionName: string) => CloudChatTarget | null;
  deliverToChat?: (
    target: CloudChatTarget,
    message: { text: string; blocks?: readonly Record<string, unknown>[]; privateTo?: readonly string[] },
  ) => Promise<CloudChatDeliveryReply>;
  personWroteFirst?: (target: CloudChatTarget) => boolean;
  resolveActorContact?: (
    session: CloudAgentsSession,
    input: { runId: string; actorUserId: string | null },
  ) => Promise<string | null>;
  slackUserIdsForContact?: (contactId: string, instanceId: string) => string[];
  contactName?: (contactId: string) => string | null;
  /** Re-renders a bound thread's run card. */
  updateRunCard?: (thread: CloudThreadRun, update: { status: string; summary: string | null }) => Promise<unknown>;
  /** A run started by `ravi tasks dispatch --cloud` (its result and approvals go through the task watcher). */
  isTaskRun?: (runId: string) => boolean;
}

export interface CloudDeliveryTickResult {
  status: "idle" | "ran" | "skipped";
  reason?: "no_login";
  processed: number;
  done: number;
  skipped: number;
  failed: number;
  retried: number;
}

type Outcome = { state: "done" | "skipped" | "failed"; reason?: string };

/**
 * Records a Console inbox item this installation must render in a session's
 * chat. Called once per newly delivered item, before the inbox item is
 * acknowledged. Returns `ignored` for anything that is not a session delivery
 * of a cloud run (the user-targeted notifications of the same types included).
 */
export function acceptCloudInboxItem(item: InboxNatsPayload): "recorded" | "duplicate" | "ignored" {
  if (item.category !== CLOUD_INBOX_CATEGORY || !isCloudDeliveryEventType(item.eventType)) return "ignored";
  const payload = objectValue(item.payload);
  const delivery = normalizeDelivery(payload?.delivery);
  const runId = stringOrNull(payload?.runId);
  if (!payload || !runId || delivery?.kind !== "session" || !delivery.sessionName) return "ignored";
  const created = dbRecordCloudDeliveryItem({
    itemId: item.eventId,
    eventType: item.eventType,
    runId,
    sessionName: delivery.sessionName,
    payload: { ...payload, occurredAt: item.occurredAt },
  });
  if (created) singleton?.poke();
  return created ? "recorded" : "duplicate";
}

export class CloudDeliveryRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<CloudDeliveryTickResult> | null = null;
  private readonly intervalMs: number;

  constructor(private readonly deps: CloudDeliveryRunnerDeps = {}) {
    this.intervalMs = deps.intervalMs ?? CLOUD_DELIVERY_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting cloud delivery runner", { intervalMs: this.intervalMs });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log.info("Stopped cloud delivery runner");
  }

  /** A new item was recorded: work it off soon instead of on the next interval. */
  poke(): void {
    if (this.running && !this.inFlight) this.schedule(0);
  }

  /** One pass now; overlapping calls share it. */
  tickOnce(): Promise<CloudDeliveryTickResult> {
    if (this.inFlight) return this.inFlight;
    const current = this.tick().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = current;
    return current;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickOnce()
        .catch((error) => log.error("Cloud delivery pass failed", { error: errorMessage(error) }))
        .finally(() => this.schedule(this.intervalMs));
    }, delay);
    this.timer.unref?.();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async tick(): Promise<CloudDeliveryTickResult> {
    const result: CloudDeliveryTickResult = {
      status: "idle",
      processed: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      retried: 0,
    };
    const due = dbListDueCloudDeliveryItems(this.now(), BATCH);
    if (due.length === 0) return result;
    let session: CloudAgentsSession | null = null;
    try {
      const options: CloudAgentsSessionOptions = { resolveProject: false };
      session = await (this.deps.openSession ?? openCloudAgentsSession)(options);
    } catch {
      session = null;
    }
    // Without a login nothing is claimed: the items wait for the next pass.
    if (!session) return { ...result, status: "skipped", reason: "no_login" };
    result.status = "ran";
    for (const item of due) {
      if (!dbClaimCloudDeliveryItem(item.itemId, this.now())) continue;
      result.processed += 1;
      let outcome: Outcome;
      try {
        outcome = await this.process(item, session);
      } catch (error) {
        const attempts = item.attempts + 1;
        const message = errorMessage(error);
        if (attempts >= CLOUD_DELIVERY_MAX_ATTEMPTS) {
          dbFinishCloudDeliveryItem(item.itemId, "failed", message, this.now());
          result.failed += 1;
          log.warn("Gave up a cloud run event", { itemId: item.itemId, eventType: item.eventType, error: message });
        } else {
          const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
          dbRetryCloudDeliveryItem(item.itemId, message, this.now() + delay, this.now());
          result.retried += 1;
          log.debug("Retrying a cloud run event", { itemId: item.itemId, eventType: item.eventType, attempts });
        }
        continue;
      }
      dbFinishCloudDeliveryItem(item.itemId, outcome.state, outcome.reason ?? null, this.now());
      result[outcome.state] += 1;
      if (outcome.state === "failed") {
        log.warn("Cloud run event not delivered", {
          itemId: item.itemId,
          eventType: item.eventType,
          reason: outcome.reason,
        });
      }
    }
    return result;
  }

  private async process(item: CloudDeliveryItem, session: CloudAgentsSession): Promise<Outcome> {
    const target = normalizeDelivery(item.payload.delivery);
    if (target?.installationId && session.installationId && target.installationId !== session.installationId) {
      return { state: "skipped", reason: "the event is for another installation" };
    }
    switch (item.eventType as CloudDeliveryEventType) {
      case "cloud_agents.run.result":
        return this.result(item, session);
      case "cloud_agents.approval.requested":
        return this.approval(item, session);
      case "cloud_agents.question.asked":
        return this.question(item, session);
      case "cloud_agents.delivery.message":
        return this.message(item);
      case "cloud_agents.run.thread":
        return this.thread(item);
      default:
        return { state: "skipped", reason: "unknown event type" };
    }
  }

  private isTaskRun(runId: string): boolean {
    return (this.deps.isTaskRun ?? ((id: string) => dbGetCloudTaskRun(id) !== null))(runId);
  }

  private sessionName(item: CloudDeliveryItem): string | null {
    if (!item.sessionName) return null;
    return (this.deps.resolveSessionName ?? ((name: string) => resolveSession(name)?.name ?? null))(item.sessionName);
  }

  /** The chat the run was started in, else the session's current chat. */
  private chat(item: CloudDeliveryItem, sessionName: string): CloudChatTarget | null {
    const current = (this.deps.resolveSessionChat ?? defaultResolveSessionChat)(sessionName);
    const saved = normalizeDelivery(item.payload.delivery)?.chat;
    return saved ? chatFromDelivery(saved, current) : current;
  }

  private inform(sessionName: string, prompt: string, item: CloudDeliveryItem): Promise<void> {
    return (this.deps.informSession ?? defaultInformSession)(
      sessionName,
      prompt,
      `cloud-delivery:${item.itemId}`,
      this.chat(item, sessionName),
    );
  }

  private async result(item: CloudDeliveryItem, session: CloudAgentsSession): Promise<Outcome> {
    if (this.isTaskRun(item.runId)) return { state: "skipped", reason: "task run: the task watcher delivers it" };
    const sessionName = this.sessionName(item);
    if (!sessionName) return { state: "failed", reason: `session ${item.sessionName ?? "-"} not found` };
    const payload = item.payload;
    const status = stringOrNull(payload.status) ?? "completed";
    if (item.informedAt === null) {
      const outputs = Array.isArray(payload.outputs)
        ? payload.outputs.flatMap((entry) => {
            const output = objectValue(entry);
            return output && typeof output.id === "string"
              ? [{ id: output.id, name: stringOrNull(output.name) ?? output.id, size: numberOr(output.size, 0) }]
              : [];
          })
        : [];
      await this.inform(
        sessionName,
        buildCloudResultInform({
          runId: item.runId,
          agentName: stringOrNull(payload.agentName) ?? "",
          status,
          costUsd: numberOr(payload.costUsd, 0),
          costBrl: numberOrNull(payload.costBrl),
          result: stringOrNull(payload.result),
          outputs,
          url: stringOrNull(payload.url),
        }),
        item,
      );
      dbMarkCloudDeliveryItemInformed(item.itemId, this.now());
    }
    try {
      await session.client.markDelivered(item.runId, "result");
    } catch (error) {
      // A run the Console no longer has needs no acknowledgement.
      if (!(isCloudAuthError(error) && (error.code === "NOT_FOUND" || error.status === 404))) throw error;
    }
    if (isTerminalCloudRunStatus(status)) dbCloseCloudChatRun(item.runId, this.now());
    return { state: "done" };
  }

  private async approval(item: CloudDeliveryItem, session: CloudAgentsSession): Promise<Outcome> {
    if (this.isTaskRun(item.runId)) return { state: "skipped", reason: "task run: the task watcher relays it" };
    const sessionName = this.sessionName(item);
    if (!sessionName) return { state: "failed", reason: `session ${item.sessionName ?? "-"} not found` };
    const payload = item.payload;
    const approvalId = stringOrNull(payload.approvalId);
    const tool = stringOrNull(payload.tool);
    if (!approvalId || !tool) return { state: "failed", reason: "approval event without approvalId or tool" };
    const actorUserId = stringOrNull(payload.actorUserId);
    const actorContactId = await (this.deps.resolveActorContact ?? resolveRunActorContact)(session, {
      runId: item.runId,
      actorUserId,
    });
    const personName = this.personName(payload, actorContactId);
    const agentName = stringOrNull(payload.agentName) ?? "";
    const server = stringOrNull(payload.server);
    const inputPreview = stringOrNull(payload.inputPreview);
    const code = cloudApprovalCode(approvalId);
    dbRecordCloudChatApproval({
      approvalId,
      runId: item.runId,
      sessionName,
      agentName,
      tool,
      actorUserId,
      actorContactId,
      actorName: personName,
      now: this.now(),
    });
    let via: CloudApprovalInformInput["via"] = actorContactId ? "reply_code" : "console";
    const chat = this.chat(item, sessionName);
    if (actorContactId && chat && normalizeChatChannel(chat.channel) === "slack") {
      const userIds = (this.deps.slackUserIdsForContact ?? defaultSlackUserIdsForContact)(
        actorContactId,
        chat.instanceId ?? chat.accountId,
      );
      if (userIds.length > 0) {
        try {
          const card = buildCloudApprovalSlackCard({
            approvalId,
            runId: item.runId,
            agentName,
            tool,
            server,
            inputPreview,
            code,
          });
          await (this.deps.deliverToChat ?? defaultDeliverToChat)(chat, {
            text: card.text ?? `Aprovação pedida: ${tool}`,
            blocks: card.blocks,
            privateTo: userIds,
          });
          via = "slack_card";
        } catch (error) {
          log.warn("Private approval card not delivered; asking for the reply code", {
            runId: item.runId,
            error: errorMessage(error),
          });
        }
      }
    }
    await this.inform(
      sessionName,
      buildCloudApprovalInform({
        runId: item.runId,
        agentName,
        approvalId,
        code,
        tool,
        server,
        inputPreview,
        personName,
        via,
        url: stringOrNull(payload.url),
      }),
      item,
    );
    dbMarkCloudDeliveryItemInformed(item.itemId, this.now());
    return { state: "done" };
  }

  private async question(item: CloudDeliveryItem, session: CloudAgentsSession): Promise<Outcome> {
    const sessionName = this.sessionName(item);
    if (!sessionName) return { state: "failed", reason: `session ${item.sessionName ?? "-"} not found` };
    const payload = item.payload;
    const questionId = stringOrNull(payload.questionId);
    const question = stringOrNull(payload.question);
    if (!questionId || !question) return { state: "failed", reason: "question event without questionId or question" };
    const actorContactId = await (this.deps.resolveActorContact ?? resolveRunActorContact)(session, {
      runId: item.runId,
      actorUserId: stringOrNull(payload.actorUserId),
    });
    dbRecordCloudChatQuestion({
      questionId,
      runId: item.runId,
      sessionName,
      actorContactId,
      now: this.now(),
    });
    await this.inform(
      sessionName,
      buildCloudQuestionInform({
        runId: item.runId,
        agentName: stringOrNull(payload.agentName) ?? "",
        questionId,
        question,
        options: stringArray(payload.options),
        personName: this.personName(payload, actorContactId),
        url: stringOrNull(payload.url),
      }),
      item,
    );
    dbMarkCloudDeliveryItemInformed(item.itemId, this.now());
    return { state: "done" };
  }

  private async message(item: CloudDeliveryItem): Promise<Outcome> {
    if (item.informedAt !== null) return { state: "done" };
    const sessionName = this.sessionName(item);
    if (!sessionName) return { state: "failed", reason: `session ${item.sessionName ?? "-"} not found` };
    const text = (stringOrNull(item.payload.text) ?? stringOrNull(item.payload.message) ?? "").trim();
    if (!text) return { state: "failed", reason: "message event without text" };
    const chat = this.chat(item, sessionName);
    // Never a new conversation: only the chat the session already talks in.
    if (!chat) return { state: "failed", reason: "the session has no chat" };
    // WhatsApp (and every channel but Slack): only where a person wrote first.
    if (
      normalizeChatChannel(chat.channel) !== "slack" &&
      !(this.deps.personWroteFirst ?? defaultPersonWroteFirst)(chat)
    ) {
      return { state: "failed", reason: "nobody wrote in this chat first" };
    }
    await (this.deps.deliverToChat ?? defaultDeliverToChat)(chat, {
      text: text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…` : text,
    });
    // Sent: a retry (of the bookkeeping) never sends it twice.
    dbMarkCloudDeliveryItemInformed(item.itemId, this.now());
    return { state: "done" };
  }

  private async thread(item: CloudDeliveryItem): Promise<Outcome> {
    const threadKey = stringOrNull(item.payload.threadKey);
    const status = stringOrNull(item.payload.status);
    if (!threadKey || !status) return { state: "failed", reason: "thread event without threadKey or status" };
    const thread = dbListCloudThreadsForRun(item.runId).find((entry) => entry.threadKey === threadKey);
    if (!thread) return { state: "skipped", reason: "no local binding for this thread" };
    const terminal = isTerminalCloudRunStatus(status);
    // A late update of a run that already ended never reopens its card.
    if (thread.endedAt !== null && !terminal) return { state: "skipped", reason: "the binding already ended" };
    await (this.deps.updateRunCard ?? ((entry, update) => updateCloudRunCard(entry, update)))(thread, {
      status,
      summary: stringOrNull(item.payload.summary),
    });
    dbUpdateCloudThreadRun(thread.id, { status }, this.now());
    if (terminal) {
      dbEndCloudThreadRuns(item.runId, status, this.now());
      dbCloseCloudChatRun(item.runId, this.now());
    }
    return { state: "done" };
  }

  private personName(payload: Record<string, unknown>, contactId: string | null): string {
    const fromConsole = stringOrNull(objectValue(payload.actorContact)?.name)?.trim();
    const local = contactId ? (this.deps.contactName ?? defaultContactName)(contactId) : null;
    return fromConsole || local || "a pessoa da run";
  }
}

async function defaultInformSession(
  sessionName: string,
  prompt: string,
  messageId: string,
  source: CloudChatTarget | null,
): Promise<void> {
  await publishSessionPrompt(
    sessionName,
    {
      prompt,
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "default",
      ...(source ? { source } : {}),
    },
    { messageId },
  );
}

function errorMessage(error: unknown): string {
  if (isCloudAuthError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

let singleton: CloudDeliveryRunner | null = null;

export function getCloudDeliveryRunner(): CloudDeliveryRunner {
  singleton ??= new CloudDeliveryRunner();
  return singleton;
}

export async function startCloudDeliveryRunner(): Promise<void> {
  await getCloudDeliveryRunner().start();
}

export async function stopCloudDeliveryRunner(): Promise<void> {
  if (singleton) {
    await singleton.stop();
    singleton = null;
  }
}

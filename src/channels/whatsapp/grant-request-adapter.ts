/**
 * WhatsApp adapter for grant requests.
 *
 * The core (`src/permissions/grant-requests`) decides who may approve and applies
 * the grant. This file only does what is WhatsApp: find the grantors reachable in
 * a WhatsApp DM, send each one the request as a message, and turn a quote-reply
 * to that message into a verified actor handed to the core's single decision
 * path. Who answered is the platform's own sender id of the reply event. The
 * words of the reply only choose approve or reject; they never say who the
 * sender is.
 */

import { DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS } from "../../approval/timeouts.js";
import { nats as runtimeNats } from "../../nats.js";
import { findGrantRequestDeliveryByRef } from "../../permissions/grant-requests/store.js";
import {
  decideGrantRequest,
  registerGrantApprovalAdapter,
  unregisterGrantApprovalAdapter,
  type GrantRequestServiceDependencies,
} from "../../permissions/grant-requests/service.js";
import type {
  GrantApprovalChannelAdapter,
  GrantDecision,
  GrantDecisionRefusal,
  GrantRequestRecord,
  ReachableContact,
} from "../../permissions/grant-requests/types.js";
import { dbListInstances, getDb } from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";
import { requestReply as runtimeRequestReply } from "../../utils/request-reply.js";

const log = logger.child("whatsapp:grant-request");

export const WHATSAPP_GRANT_REQUEST_CHANNEL = "whatsapp";

export interface WhatsAppGrantRequestDependencies {
  /** The core's clock and adapter list; tests replace them. */
  readonly service?: GrantRequestServiceDependencies;
  readonly requestReply: typeof runtimeRequestReply;
}

const defaultDependencies: WhatsAppGrantRequestDependencies = { requestReply: runtimeRequestReply };

interface SendReply {
  readonly messageId?: unknown;
}

interface DmRow {
  contact_id: string;
  platform_chat_id: string;
  instance_id: string;
}

export function createWhatsAppGrantApprovalAdapter(
  dependencies: WhatsAppGrantRequestDependencies = defaultDependencies,
): GrantApprovalChannelAdapter {
  return {
    channel: WHATSAPP_GRANT_REQUEST_CHANNEL,

    /**
     * Contacts with a WhatsApp DM on an enabled WhatsApp instance, reachable at
     * the DM they used most recently. A contact never talked to cannot be asked.
     */
    listReachableContacts(): readonly ReachableContact[] {
      const accounts = new Map<string, string>();
      for (const instance of dbListInstances()) {
        if (instance.channel !== "whatsapp" || instance.enabled === false || instance.deletedAt) continue;
        accounts.set(instance.name, instance.name);
        if (instance.instanceId) accounts.set(instance.instanceId, instance.name);
      }
      if (accounts.size === 0) return [];
      const rows = getDb()
        .prepare(
          `SELECT cp.contact_id AS contact_id, c.platform_chat_id AS platform_chat_id, c.instance_id AS instance_id
             FROM chat_participants cp
             JOIN chats c ON c.id = cp.chat_id
            WHERE c.channel LIKE 'whatsapp%' AND c.chat_type = 'dm'
              AND cp.contact_id IS NOT NULL AND cp.status = 'active'
            ORDER BY cp.last_seen_at DESC`,
        )
        .all() as DmRow[];
      const reachable = new Map<string, ReachableContact>();
      for (const row of rows) {
        const accountId = accounts.get(row.instance_id);
        if (!accountId || reachable.has(row.contact_id)) continue;
        reachable.set(row.contact_id, {
          contactId: row.contact_id,
          address: { accountId, to: row.platform_chat_id },
        });
      }
      return [...reachable.values()];
    },

    async deliver({ request, address }) {
      const accountId = stringField(address, "accountId");
      const to = stringField(address, "to");
      if (!accountId || !to) throw new Error("WhatsApp address is incomplete.");
      const reply = await dependencies.requestReply<SendReply>(
        "ravi.outbound.deliver",
        { channel: WHATSAPP_GRANT_REQUEST_CHANNEL, accountId, to, text: buildRequestText(request) },
        DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS,
      );
      const messageId = typeof reply.messageId === "string" ? reply.messageId.trim() : "";
      if (!messageId) throw new Error("WhatsApp did not confirm the message.");
      return { ref: { accountId, to, messageId } };
    },
  };
}

function buildRequestText(request: GrantRequestRecord): string {
  const minutes = Math.max(1, Math.round((request.expiresAt - request.createdAt) / 60_000));
  const asker = request.requester.agentId ? `O agente ${request.requester.agentId}` : "Um agente";
  return [
    "*Pedido de acesso total*",
    `${asker} pede acesso total para *${request.plan.contactLabel}* (contact:${request.plan.contactId}) no chat *${request.plan.chatLabel}* (chat:${request.plan.chatId}), só nesse chat.`,
    `Executor: ${request.plan.executorAgentId} (as permissões dele não mudam).`,
    "",
    "Responda a *esta mensagem* com *aprovo* ou *nego*. Nada muda até alguém aprovar.",
    `O pedido expira em ${minutes} min.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Inbound: a quote-reply to a grant request message
// ---------------------------------------------------------------------------

const APPROVE_WORDS = new Set(["aprovo", "aprovado", "aprovar", "approve", "approved"]);
const REJECT_WORDS = new Set(["nego", "negado", "negar", "rejeito", "reject", "rejected", "deny"]);

/** One whole word, nothing else: "nao aprovo" or a sentence that merely contains the word is not an answer. */
export function parseGrantReply(text: string | undefined): GrantDecision | null {
  const word = (text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[\s.!?,;:]+/g, " ")
    .trim();
  if (APPROVE_WORDS.has(word)) return "approve";
  if (REJECT_WORDS.has(word)) return "reject";
  return null;
}

export type WhatsAppGrantRequestReplyOutcome =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly result: "approved" | "rejected" | GrantDecisionRefusal | "not_an_answer";
    };

/**
 * Handle one `ravi.inbound.reply`. Returns `{handled:false}` unless the reply
 * quotes a message this adapter sent for a grant request. `senderId` is the
 * platform's sender of the reply; the core decides whether that person may.
 */
export async function handleWhatsAppGrantRequestReply(
  data: Record<string, unknown>,
  dependencies: WhatsAppGrantRequestDependencies = defaultDependencies,
): Promise<WhatsAppGrantRequestReplyOutcome> {
  const targetMessageId = stringField(data, "targetMessageId");
  if (!targetMessageId) return { handled: false };
  const delivery = findGrantRequestDeliveryByRef(WHATSAPP_GRANT_REQUEST_CHANNEL, "messageId", targetMessageId);
  if (!delivery) return { handled: false };

  const decision = parseGrantReply(stringField(data, "text"));
  if (!decision) return { handled: true, result: "not_an_answer" };

  const senderId = stringField(data, "senderId");
  const outcome = decideGrantRequest(
    {
      requestId: delivery.requestId,
      decision,
      actor: { channel: WHATSAPP_GRANT_REQUEST_CHANNEL, senderId },
    },
    ...(dependencies.service ? [dependencies.service] : []),
  );

  const accountId = stringField(delivery.ref, "accountId");
  const to = stringField(delivery.ref, "to");
  const say = async (text: string) => {
    if (!accountId || !to) return;
    await dependencies
      .requestReply(
        "ravi.outbound.deliver",
        { channel: WHATSAPP_GRANT_REQUEST_CHANNEL, accountId, to, text },
        DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS,
      )
      .catch((error: unknown) => {
        log.warn("Could not confirm a grant request answer", {
          requestId: delivery.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };

  if (outcome.kind === "refused") {
    // Say what happened only to someone who was actually asked; a stranger learns nothing.
    if (outcome.reason === "expired") await say("Esse pedido expirou. Nada foi concedido.");
    else if (outcome.reason === "already_decided") await say("Esse pedido já foi decidido.");
    return { handled: true, result: outcome.reason };
  }
  const request = outcome.request;
  if (request.status === "rejected") {
    await say("Pedido negado. Nada foi concedido.");
    return { handled: true, result: "rejected" };
  }
  await say(
    request.outcome === "failed"
      ? "Aprovado, mas o acesso não pôde ser aplicado. Nada foi concedido."
      : `Aprovado. ${request.plan.contactLabel} agora tem acesso total em ${request.plan.chatLabel}.`,
  );
  return { handled: true, result: "approved" };
}

// ---------------------------------------------------------------------------
// Daemon runner
// ---------------------------------------------------------------------------

let runnerAbort: (() => void) | null = null;

export async function startWhatsAppGrantRequestRunner(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
): Promise<void> {
  if (runnerAbort) return;
  registerGrantApprovalAdapter(createWhatsAppGrantApprovalAdapter());
  const stream = natsClient.subscribe("ravi.inbound.reply", { queue: "ravi-grant-request-replies" });
  let stopped = false;
  runnerAbort = () => {
    stopped = true;
    void stream.return?.(undefined);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (stopped) return;
        try {
          await handleWhatsAppGrantRequestReply(event.data as Record<string, unknown>);
        } catch (error) {
          log.warn("Failed to handle a grant request reply", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (!stopped) log.error("WhatsApp grant request runner stopped", { error });
    }
  })();
}

export function stopWhatsAppGrantRequestRunner(): void {
  runnerAbort?.();
  runnerAbort = null;
  unregisterGrantApprovalAdapter(WHATSAPP_GRANT_REQUEST_CHANNEL);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

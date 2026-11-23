/**
 * Slack adapter for grant requests.
 *
 * The core (`src/permissions/grant-requests`) decides who may approve and
 * applies the grant. This file only does what is Slack: find the grantors a
 * Slack workspace can reach, send each one a private card, and turn a click on
 * that card into a verified actor handed to the core's single decision path.
 * The identity of whoever clicked is the Slack user id of the interaction
 * payload, resolved to a contact by the core gate; nothing typed is read.
 */

import { DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS } from "../../approval/timeouts.js";
import {
  buildSlackApprovalClickNotice,
  buildSlackApprovalFinalMessage,
  buildSlackPermissionGrantMessage,
  parseSlackGrantActionValue,
  slackPermissionGrantClickFromActionId,
  type SlackApprovalClickNotice,
} from "../../approval/slack-blocks.js";
import { configStore } from "../../config-store.js";
import { isSlackHumanUserId, listOwnedPlatformIdentities } from "../../contacts.js";
import { nats as runtimeNats } from "../../nats.js";
import {
  decideGrantRequest,
  registerGrantApprovalAdapter,
  unregisterGrantApprovalAdapter,
  type GrantRequestServiceDependencies,
} from "../../permissions/grant-requests/service.js";
import type {
  GrantApprovalChannelAdapter,
  GrantDecisionRefusal,
  GrantRequestRecord,
  ReachableContact,
} from "../../permissions/grant-requests/types.js";
import { listGrantRequestDeliveries } from "../../permissions/grant-requests/store.js";
import { dbListInstances } from "../../router/router-db.js";
import { logger } from "../../utils/logger.js";
import { requestReply as runtimeRequestReply } from "../../utils/request-reply.js";
import { resolveSlackInstanceAliases } from "./instance-alias.js";
import { respondToSlackInteraction } from "./interactions.js";

const log = logger.child("slack:grant-request");

export const SLACK_GRANT_REQUEST_CHANNEL = "slack";
/** Grant request ids carry this prefix; the legacy approval flow never uses it. */
export const GRANT_REQUEST_ID_PREFIX = "pgr_";

export interface SlackGrantRequestDependencies {
  /** The core's clock and adapter list; tests replace them. */
  readonly service?: GrantRequestServiceDependencies;
  readonly requestReply: typeof runtimeRequestReply;
  readonly respond: (input: { responseUrlId: string; payload: Record<string, unknown> }) => Promise<unknown>;
}

const defaultDependencies: SlackGrantRequestDependencies = {
  requestReply: runtimeRequestReply,
  respond: respondToSlackInteraction,
};

interface SlackDeliveryReply {
  readonly messageId?: string;
  readonly deliveries?: ReadonlyArray<{ userId?: unknown; kind?: unknown; chatId?: unknown; messageId?: unknown }>;
}

export function createSlackGrantApprovalAdapter(
  dependencies: SlackGrantRequestDependencies = defaultDependencies,
): GrantApprovalChannelAdapter {
  return {
    channel: SLACK_GRANT_REQUEST_CHANNEL,

    listReachableContacts(): readonly ReachableContact[] {
      const reachable = new Map<string, ReachableContact>();
      let config: Parameters<typeof resolveSlackInstanceAliases>[0] = null;
      try {
        config = configStore.getConfig();
      } catch (error) {
        // Without config the lookup stays on each instance's own name: narrower, never wider.
        log.warn("Slack grant adapter could not read the router config", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const instance of dbListInstances()) {
        if (instance.channel !== "slack" || instance.enabled === false || instance.deletedAt) continue;
        const aliases = resolveSlackInstanceAliases(config, instance.name);
        for (const identity of listOwnedPlatformIdentities({
          channel: "slack",
          instanceIds: [...aliases.scopedAliases, ""],
        })) {
          if (identity.ownerType !== "contact" || !identity.ownerId) continue;
          if (!isSlackHumanUserId(identity.platformUserId)) continue;
          const userId = identity.platformUserId.trim().toUpperCase();
          reachable.set(`${identity.ownerId}:${instance.name}:${userId}`, {
            contactId: identity.ownerId,
            address: { accountId: instance.name, instanceId: instance.name, userId },
          });
        }
      }
      return [...reachable.values()];
    },

    async deliver({ request, address }) {
      const accountId = stringField(address, "accountId");
      const userId = stringField(address, "userId");
      if (!accountId || !userId) throw new Error("Slack address is incomplete.");
      const card = buildGrantRequestCard(request, userId);
      // `privateTo` sends an ephemeral card where the person is, or their DM with the
      // app when they are not in that chat; a user id as `to` has no chat, so it is a DM.
      const reply = await dependencies.requestReply<SlackDeliveryReply>(
        "ravi.outbound.deliver",
        {
          channel: SLACK_GRANT_REQUEST_CHANNEL,
          accountId,
          to: userId,
          text: card.text,
          blocks: card.blocks,
          privateTo: [userId],
        },
        DEFAULT_APPROVAL_DELIVERY_TIMEOUT_MS,
      );
      const delivered = reply.deliveries?.find((entry) => typeof entry.messageId === "string");
      const messageId = (typeof delivered?.messageId === "string" ? delivered.messageId : undefined) ?? reply.messageId;
      if (!messageId) throw new Error("Slack did not confirm the card.");
      return {
        ref: {
          accountId,
          userId,
          messageId,
          ...(typeof delivered?.chatId === "string" ? { chatId: delivered.chatId } : {}),
          ...(typeof delivered?.kind === "string" ? { kind: delivered.kind } : {}),
        },
      };
    },
  };
}

function buildGrantRequestCard(request: GrantRequestRecord, userId: string) {
  return buildSlackPermissionGrantMessage({
    requestId: request.id,
    capabilityText: "admin:system:*",
    ...(request.requester.agentId ? { agentId: request.requester.agentId } : {}),
    adminUserIds: [userId],
    allowed: ["full-access"],
    scopes: ["chat"],
    explicit: {
      contactLabel: request.plan.contactLabel,
      chatLabel: request.plan.chatLabel,
      contactId: request.plan.contactId,
      chatId: request.plan.chatId,
      executorAgentId: request.plan.executorAgentId,
    },
  });
}

// ---------------------------------------------------------------------------
// Inbound: a click on a grant request card
// ---------------------------------------------------------------------------

export type SlackGrantRequestClickOutcome =
  | { readonly handled: false }
  | { readonly handled: true; readonly result: "approved" | "rejected" | GrantDecisionRefusal | "not_offered" };

/**
 * Handle one `ravi.inbound.interaction`. Returns `{handled:false}` for anything
 * that is not a click on a grant request card (the legacy approval flow owns
 * those). Whoever clicked is the Slack user id of the payload; the core decides
 * whether that person may.
 */
export async function handleSlackGrantRequestInteraction(
  data: Record<string, unknown>,
  dependencies: SlackGrantRequestDependencies = defaultDependencies,
): Promise<SlackGrantRequestClickOutcome> {
  const click = slackPermissionGrantClickFromActionId(typeof data.actionId === "string" ? data.actionId : undefined);
  if (!click) return { handled: false };
  const selected = typeof data.selectedOption === "string" ? data.selectedOption : undefined;
  const value = typeof data.value === "string" ? data.value : undefined;
  const requestId = parseSlackGrantActionValue(selected ?? value).requestId;
  if (!requestId.startsWith(GRANT_REQUEST_ID_PREFIX)) return { handled: false };

  const responseUrlId = typeof data.responseUrlId === "string" ? data.responseUrlId.trim() : "";
  const reply = async (payload: Record<string, unknown>) => {
    if (!responseUrlId) return;
    await dependencies.respond({ responseUrlId, payload }).catch((error: unknown) => {
      log.warn("Could not answer a grant request click", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  const notice = (kind: SlackApprovalClickNotice, replaceOriginal: boolean) =>
    reply({
      response_type: "ephemeral",
      replace_original: replaceOriginal,
      text: buildSlackApprovalClickNotice(kind),
    });

  // The explicit request offers exactly one intent. Anything else is not on the card.
  if (click !== "full-access" && click !== "ignore") return { handled: true, result: "not_offered" };

  const senderId = typeof data.userId === "string" ? data.userId.trim() : "";
  const accountId = typeof data.accountId === "string" ? data.accountId.trim() : undefined;
  const instanceId = typeof data.instanceId === "string" ? data.instanceId.trim() : undefined;

  // The click must come from the person the card was sent to, on the card that was sent.
  const delivery = findDeliveredCard(requestId, senderId, data);
  const outcome = decideGrantRequest(
    {
      requestId,
      decision: click === "full-access" ? "approve" : "reject",
      // No recorded card for this person: an empty binding matches nobody, so the core refuses.
      deliveredTo: delivery?.contactId ?? "",
      actor: {
        channel: SLACK_GRANT_REQUEST_CHANNEL,
        senderId,
        ...(accountId ? { accountId } : {}),
        ...(instanceId ? { instanceId } : {}),
      },
    },
    ...(dependencies.service ? [dependencies.service] : []),
  );

  if (outcome.kind === "refused") {
    await notice(refusalNotice(outcome.reason), outcome.reason !== "not_grantor" && outcome.reason !== "unknown_actor");
    return { handled: true, result: outcome.reason };
  }
  const request = outcome.request;
  const approved = request.status === "approved" || request.status === "failed";
  const detail =
    request.outcome === "failed"
      ? "grant failed"
      : `Full access for ${request.plan.contactLabel} in ${request.plan.chatLabel}`;
  const final = buildSlackApprovalFinalMessage({
    type: "permission",
    outcome: approved ? "approved" : "rejected",
    ...(approved ? { detail } : {}),
    decidedBy: senderId,
  });
  await reply({ replace_original: true, text: final.text, blocks: final.blocks });
  return { handled: true, result: approved ? "approved" : "rejected" };
}

/**
 * The recorded Slack delivery that this click answers. A direct-message card also pins the
 * message and the conversation it was posted in; an ephemeral card is private to the person.
 */
function findDeliveredCard(requestId: string, senderId: string, data: Record<string, unknown>) {
  const wanted = senderId.toUpperCase();
  const messageTs = typeof data.messageTs === "string" ? data.messageTs.trim() : "";
  const channelId = typeof data.channelId === "string" ? data.channelId.trim() : "";
  for (const delivery of listGrantRequestDeliveries(requestId)) {
    if (delivery.channel !== SLACK_GRANT_REQUEST_CHANNEL) continue;
    if (stringField(delivery.ref, "userId").toUpperCase() !== wanted) continue;
    if (stringField(delivery.ref, "kind") === "dm") {
      const cardMessage = stringField(delivery.ref, "messageId");
      const cardChat = stringField(delivery.ref, "chatId");
      if (messageTs && cardMessage && messageTs !== cardMessage) continue;
      if (channelId && cardChat && channelId !== cardChat) continue;
    }
    return delivery;
  }
  return null;
}

function refusalNotice(reason: GrantDecisionRefusal): SlackApprovalClickNotice {
  switch (reason) {
    case "not_found":
      return "unknown";
    case "expired":
      return "expired";
    case "already_decided":
      return "already_decided";
    default:
      return "unauthorized";
  }
}

// ---------------------------------------------------------------------------
// Daemon runner
// ---------------------------------------------------------------------------

let runnerAbort: (() => void) | null = null;

export async function startSlackGrantRequestRunner(
  natsClient: Pick<typeof runtimeNats, "subscribe"> = runtimeNats,
): Promise<void> {
  if (runnerAbort) return;
  registerGrantApprovalAdapter(createSlackGrantApprovalAdapter());
  const stream = natsClient.subscribe("ravi.inbound.interaction", { queue: "ravi-grant-request-clicks" });
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
          await handleSlackGrantRequestInteraction(event.data as Record<string, unknown>);
        } catch (error) {
          log.warn("Failed to handle a grant request click", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (!stopped) log.error("Slack grant request runner stopped", { error });
    }
  })();
}

export function stopSlackGrantRequestRunner(): void {
  runnerAbort?.();
  runnerAbort = null;
  unregisterGrantApprovalAdapter(SLACK_GRANT_REQUEST_CHANNEL);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

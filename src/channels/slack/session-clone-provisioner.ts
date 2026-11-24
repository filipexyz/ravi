/**
 * Slack's part in cloning a session (src/sessions/clone.ts): create a private
 * channel with the clone's name, route it to the same agent, invite the asker,
 * and say which session an inbound message there will land in.
 *
 * It reuses `ravi slack channels-create --private --agent` (#867): one place
 * creates, routes and invites Slack channels.
 *
 * Spec: sessions/clone, channels/slack/commands.
 */

import { configStore } from "../../config-store.js";
import { matchRoute, previewCommittedSessionKey } from "../../router/index.js";
import {
  type SessionCloneProvisioned,
  type SessionCloneProvisioner,
  type SessionCloneProvisionInput,
  SessionCloneError,
} from "../../sessions/clone.js";

export const SLACK_CLONE_CHANNEL = "slack";

/** Slack user ids: what `conversations.invite` takes. Anything else is not invited. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

type ChannelsCreate = (input: {
  name: string;
  raviChannel: string;
  inviteCsv: string | undefined;
  agentId: string;
}) => Promise<Record<string, unknown>>;

async function defaultChannelsCreate(input: Parameters<ChannelsCreate>[0]): Promise<Record<string, unknown>> {
  const { SlackCommands } = await import("../../cli/commands/slack.js");
  const payload = await new SlackCommands().channelsCreate(
    input.name,
    input.raviChannel,
    true,
    true,
    input.inviteCsv,
    input.agentId,
    false,
    undefined,
    undefined,
    undefined,
    true,
  );
  return (payload ?? {}) as Record<string, unknown>;
}

export interface SlackCloneProvisionerDeps {
  channelsCreate?: ChannelsCreate;
  sessionKeyFor?: (input: { chatId: string; routeAccountId: string }) => string | null;
}

function defaultSessionKeyFor(input: { chatId: string; routeAccountId: string }): string | null {
  // The route was just written: read it now, not at the next periodic refresh.
  configStore.refresh();
  const matched = matchRoute(configStore.getConfig(), {
    phone: input.chatId,
    channel: SLACK_CLONE_CHANNEL,
    accountId: input.routeAccountId,
    isGroup: true,
    groupId: input.chatId,
    peerKind: "group",
  });
  return matched ? previewCommittedSessionKey(matched, {}) : null;
}

export function createSlackSessionCloneProvisioner(deps: SlackCloneProvisionerDeps = {}): SessionCloneProvisioner {
  return {
    channel: SLACK_CLONE_CHANNEL,
    async provision(input: SessionCloneProvisionInput): Promise<SessionCloneProvisioned> {
      const invite = input.inviteActorIds.filter((id) => SLACK_USER_ID.test(id));
      const payload = await (deps.channelsCreate ?? defaultChannelsCreate)({
        name: input.name,
        raviChannel: input.origin.accountId,
        inviteCsv: invite.length > 0 ? invite.join(",") : undefined,
        agentId: input.agentId,
      });
      const item = payload.item as { id?: unknown } | undefined;
      const chatId = typeof item?.id === "string" ? item.id : undefined;
      if (!chatId) {
        throw new SessionCloneError("CLONE_PROVISION_FAILED", "Slack did not return the new channel id.");
      }
      const route = payload.route as { status?: string; accountId?: string; reason?: string } | undefined;
      if (route?.status !== "created" || !route.accountId) {
        throw new SessionCloneError(
          "CLONE_PROVISION_FAILED",
          `Channel ${chatId} was created but not routed to ${input.agentId}${route?.reason ? `: ${route.reason}` : ""}.`,
        );
      }
      const sessionKey = (deps.sessionKeyFor ?? defaultSessionKeyFor)({ chatId, routeAccountId: route.accountId });
      if (!sessionKey) {
        throw new SessionCloneError(
          "CLONE_PROVISION_FAILED",
          `Channel ${chatId} was routed, but its route is not visible to the router yet.`,
        );
      }
      const inviteResult = payload.invite as { status?: string } | undefined;
      return {
        chatId,
        sessionKey,
        source: { channel: SLACK_CLONE_CHANNEL, accountId: input.origin.accountId, chatId },
        invited: inviteResult?.status === "invited" ? invite.length : 0,
        inviteFailed: invite.length > 0 && inviteResult?.status !== "invited",
      };
    },
  };
}

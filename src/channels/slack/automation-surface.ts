/**
 * Slack surface for automation runs (cron and trigger `--thread`).
 *
 * When the session a run reports to lives in a Slack chat, the run shows as a thread under that
 * chat's channel root, through the same programmatic thread a `sessions create-thread` opens: a
 * `thread.create` outbound job posts the root, and the thread's session is made when it lands.
 *
 * This adapter only shows the run. The run's prompt (with its job's or trigger's own authority
 * envelope) is the core's launch, published when the thread's session is bound, never the agent's
 * bootstrap turn; and every return to the parent is the core's (`src/automation/child-runs.ts`).
 */

import {
  registerChildRunSurface,
  type AutomationChildRun,
  type ChildRunSurfaceAdapter,
} from "../../automation/child-runs.js";
import { nativeChannelCredentialConfigured } from "../account-resolution.js";
import { buildChannelChatActionJob } from "../outbound-stream.js";
import { publishChannelOutboundJobDurably } from "../outbound-publish-outbox.js";
import { loadRouterConfig } from "../../router/index.js";
import { dbFindChat, dbGetChat, dbUpsertChat } from "../../router/router-db.js";
import { getSession, listSessionSubscriptions } from "../../router/sessions.js";
import type { SessionEntry } from "../../router/types.js";
import { logger } from "../../utils/logger.js";
import { createSlackThreadLifecycle, getSlackThreadLifecycle } from "./thread-lifecycle-store.js";
import {
  closeSlackThreadRecord,
  slackThreadParentSessionKey,
  splitSlackThreadPlatformChatId,
} from "./thread-lifecycle.js";

const log = logger.child("channels:slack:automation-surface");

export interface SlackRunTarget {
  /** The channel-root session the thread is opened under (a thread child's parent). */
  rootSession: SessionEntry;
  accountId: string;
  instanceId: string;
  platformChatId: string;
}

/**
 * Where a run reporting to `parent` would show: the Slack chat the parent answers in (its output
 * chat, else any chat attached to it or to its channel root), at that chat's channel root. Null
 * when the parent has no Slack chat or the Slack account has no working credential. Read-only.
 */
export function resolveSlackRunTarget(parent: SessionEntry): SlackRunTarget | null {
  const rootKey = slackThreadParentSessionKey(parent.sessionKey);
  const rootSession = rootKey === parent.sessionKey ? parent : getSession(rootKey);
  if (!rootSession || rootSession.agentId !== parent.agentId) return null;
  const own = listSessionSubscriptions(parent.sessionKey);
  const candidateIds = [
    own.find((subscription) => subscription.outputAttachedAt !== undefined)?.chatId,
    ...own.map((subscription) => subscription.chatId),
    ...(rootSession === parent ? [] : listSessionSubscriptions(rootSession.sessionKey).map((s) => s.chatId)),
  ].filter((value): value is string => Boolean(value));
  const chat = candidateIds
    .map((chatId) => dbGetChat(chatId))
    .find((found) => found?.channel.toLowerCase() === "slack");
  if (!chat?.instanceId) return null;
  const platformChatId = splitSlackThreadPlatformChatId(chat.platformChatId)?.platformChatId ?? chat.platformChatId;
  if (!platformChatId) return null;
  if (!nativeChannelCredentialConfigured(loadRouterConfig(), chat.instanceId, "slack")) return null;
  // The native adapter uses one id for the account and the instance.
  return { rootSession, accountId: chat.instanceId, instanceId: chat.instanceId, platformChatId };
}

export const slackAutomationSurface: ChildRunSurfaceAdapter = {
  id: "slack-thread",
  canHost: (parent) => resolveSlackRunTarget(parent) !== null,
  async open({ run, parent, title }) {
    const target = resolveSlackRunTarget(parent);
    if (!target || !run.surfaceRef) throw new Error(`No Slack chat can show run ${run.id}`);
    const rootChat =
      dbFindChat({ channel: "slack", instanceId: target.instanceId, platformChatId: target.platformChatId }) ??
      dbUpsertChat({
        channel: "slack",
        instanceId: target.instanceId,
        platformChatId: target.platformChatId,
        chatType: target.platformChatId.startsWith("D") ? "dm" : "channel",
        title: target.platformChatId,
        rawProvenance: { source: "ravi.automation.run", parentSessionKey: target.rootSession.sessionKey },
      });
    const rootName = target.rootSession.name ?? target.rootSession.sessionKey;
    const requestedBy = `${run.originKind} ${run.originName}`;
    const lifecycle = createSlackThreadLifecycle({
      requestId: run.surfaceRef,
      parentSessionKey: target.rootSession.sessionKey,
      parentSessionName: rootName,
      accountId: target.accountId,
      instanceId: target.instanceId,
      platformChatId: target.platformChatId,
      rootCanonicalChatId: rootChat.id,
      initialPrompt: title,
      requestedBy,
    });
    await publishChannelOutboundJobDurably(
      buildChannelChatActionJob({
        sessionName: rootName,
        requestId: lifecycle.requestId,
        target: {
          channel: "slack",
          accountId: lifecycle.accountId,
          instanceId: lifecycle.instanceId,
          chatId: lifecycle.platformChatId,
          canonicalChatId: lifecycle.rootCanonicalChatId,
        },
        content: { type: "chat_action", actionId: "thread.create", text: title, requestedBy },
      }),
    );
  },
  async closeSurface(run: AutomationChildRun) {
    if (!run.surfaceRef) return;
    const record = getSlackThreadLifecycle(run.surfaceRef);
    if (!record || record.status === "closed") return;
    // Silent: the run's return, if any, is the core's.
    await closeSlackThreadRecord(record, undefined);
  },
};

/** Called once by the daemon: runs whose parent answers in Slack show as Slack threads. */
export function registerSlackAutomationSurface(): () => void {
  log.debug("Slack surface for automation runs registered");
  return registerChildRunSurface(slackAutomationSurface);
}

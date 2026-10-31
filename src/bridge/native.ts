import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RaviBot } from "../bot.js";
import { configStore } from "../config-store.js";
import { getOrCreateSession } from "../router/sessions.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import type { ContextAuthorizationOptions, ContextAuthorizationResult } from "../approval/service.js";
import { bridgeStateDir, getBridgeStore, type BridgeStore } from "./store.js";
import { bridgeTurnAuthority, bridgeContextCapabilities } from "./authority.js";
import { requestDigest } from "./auth.js";
import type { BridgeRuntime } from "./service.js";

export function consoleConversationCwd(conversationId: string) {
  if (!/^[0-9a-f-]{36}$/.test(conversationId)) throw new Error("Invalid bridge conversation");
  const cwd = join(bridgeStateDir(), "workspaces", conversationId);
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}
export function nativeBridgeRuntime(bot: RaviBot): BridgeRuntime {
  return {
    agents: () => Object.values(configStore.getConfig().agents).map((agent) => ({ id: agent.id, name: agent.id })),
    cancel: (sessionName) => {
      return bot.abortSession(sessionName);
    },
    start: async (turnId) => {
      const store = getBridgeStore(),
        authority = bridgeTurnAuthority(turnId, store);
      if (!authority) throw new Error("Bridge authority expired");
      const conversation = store.conversation(authority.turn.conversation_id)!;
      const agent = configStore.getConfig().agents[conversation.agent_id];
      if (!agent) throw new Error("Agent unavailable");
      getOrCreateSession(conversation.session_key, agent.id, consoleConversationCwd(conversation.id), {
        name: conversation.session_name,
        channel: "console",
      });
      const message = store.db
        .query<{ text: string }, [string]>("SELECT text FROM messages WHERE turn_id=? AND role='user'")
        .get(turnId);
      if (!message) throw new Error("Missing accepted message");
      await bot.submitBridgePrompt(conversation.session_name, {
        prompt: message.text,
        _agentId: agent.id,
        _bridgeTurnId: turnId,
      });
    },
  };
}

/** Called before generic event transport; only the human projection enters the journal. */
export function recordBridgeRuntimeEvent(topic: string, data: Record<string, unknown>, store?: BridgeStore) {
  const match = /^ravi\.session\.(console-[0-9a-f-]{36})\.runtime$/.exec(topic);
  if (!match || typeof data._bridgeTurnId !== "string") return;
  store ??= getBridgeStore();
  const conversation = store.db
    .query<import("./store.js").ConversationRow, [string]>("SELECT * FROM conversations WHERE session_name=?")
    .get(match[1]!);
  if (!conversation) return;
  if (typeof data._bridgeTurnId !== "string") return;
  const turn = store.turn(data._bridgeTurnId);
  if (!turn || turn.conversation_id !== conversation.id || !["running", "awaiting_approval"].includes(turn.status))
    return;
  if (data.type === "assistant.message" && typeof data.text === "string") {
    // Provider response policy has already accepted this message in host-event-loop.
    // Raw text.delta, reasoning, prompts and tool payloads never reach this surface.
    const message = { id: randomUUID(), role: "assistant", text: data.text, turnId: turn.id, createdAt: Date.now() };
    store.atomic(() => {
      store.db
        .query("INSERT INTO messages VALUES (?,?,?,?,?,?)")
        .run(message.id, conversation.id, message.role, message.text, turn.id, message.createdAt);
      store.event(conversation.id, "message.finalized", message);
    });
  } else if (data.type === "turn.complete") store.setTurn(turn.id, "completed");
  else if (["turn.failed", "dispatch.dropped", "session.timeout"].includes(String(data.type)))
    store.setTurn(turn.id, turn.cancel_requested ? "cancelled" : "failed");
  else if (data.type === "turn.interrupted")
    store.setTurn(turn.id, turn.cancel_requested ? "cancelled" : "interrupted_unknown");
  else if (data.type === "status")
    store.atomic(() =>
      store.event(conversation.id, "turn.activity", {
        turnId: turn.id,
        status: typeof data.status === "string" ? data.status : "running",
      }),
    );
}

export async function authorizeBridgeAction(
  opts: ContextAuthorizationOptions,
  store = getBridgeStore(),
): Promise<ContextAuthorizationResult> {
  const { context, permission, objectType, objectId } = opts;
  const deny = (reason: string): ContextAuthorizationResult => ({
    context,
    allowed: false,
    approved: false,
    inherited: false,
    reason,
  });
  const id = context.metadata?.bridgeTurnId;
  if (typeof id !== "string") return deny("Bridge actor unresolved");
  const authority = bridgeTurnAuthority(id, store);
  if (!authority) return deny("Bridge authorization expired");
  const conversation = store.conversation(authority.turn.conversation_id)!;
  if (context.agentId !== conversation.agent_id || context.sessionKey !== conversation.session_key)
    return deny("Bridge context identity mismatch");
  if (
    permission === "access" &&
    objectType === "session" &&
    ![conversation.session_name, conversation.session_key].includes(objectId)
  )
    return deny("Other conversations are outside this turn");
  const ordinary = bridgeContextCapabilities(context, store);
  if (canWithCapabilities(ordinary, permission, objectType, objectId))
    return { context, allowed: true, approved: false, inherited: true };
  if (context.kind !== "turn-runtime") return deny("A child context cannot request broader bridge authority");
  const conditional = authority.grant.agents.find((a) => a.id === conversation.agent_id)!.approvalCapabilities;
  if (!authority.grant.canApprove || !canWithCapabilities(conditional, permission, objectType, objectId))
    return deny("Console delegation does not authorize approval for this action");
  const capability = { permission, objectType, objectId },
    approvalId = randomUUID();
  const actionDigest = requestDigest({ turnId: id, capability, action: opts.eventData ?? {} });
  const command = typeof opts.eventData?.command === "string" ? opts.eventData.command.slice(0, 1000) : null;
  const description = command ?? `${permission} ${objectType}:${objectId}`;
  const expiresAt = Date.now() + Math.min(opts.timeoutMs ?? 600_000, 600_000);
  opts.beforeExternalApproval?.();
  store.atomic(() => {
    store.db
      .query(
        "INSERT INTO approvals(id,conversation_id,turn_id,capability,description,action_digest,expires_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        approvalId,
        authority.turn.conversation_id,
        id,
        JSON.stringify(capability),
        description,
        actionDigest,
        expiresAt,
      );
    store.setTurn(id, "awaiting_approval");
    store.event(authority.turn.conversation_id, "approval.opened", {
      id: approvalId,
      turnId: id,
      capability,
      description,
      actionDigest,
      version: 1,
      expiresAt,
      state: "pending",
    });
  });
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const current = bridgeTurnAuthority(id, store);
    if (!current) return deny("Turn cancelled or authorization expired");
    const row = store.db.query<{ state: string }, [string]>("SELECT state FROM approvals WHERE id=?").get(approvalId)!;
    if (row.state === "pending") {
      const currentCaps = current.grant.agents.find((a) => a.id === conversation.agent_id)!.approvalCapabilities;
      if (current.grant.canApprove && canWithCapabilities(currentCaps, permission, objectType, objectId)) continue;
      store.db
        .query("UPDATE approvals SET state='invalidated',version=version+1 WHERE id=? AND state='pending'")
        .run(approvalId);
      store.event(conversation.id, "approval.state", { id: approvalId, state: "invalidated" });
      store.setTurn(id, "running");
      return deny("Console revoked approval eligibility");
    }
    if (
      !store.db
        .query<{ count: number }, [string]>("SELECT COUNT(*) count FROM approvals WHERE turn_id=? AND state='pending'")
        .get(id)!.count
    )
      store.setTurn(id, "running");
    const allowed =
      row.state === "approved" &&
      current.grant.canApprove &&
      canWithCapabilities(
        current.grant.agents.find((a) => a.id === conversation.agent_id)!.approvalCapabilities,
        permission,
        objectType,
        objectId,
      );
    // One pending tool invocation consumes this decision. Never broaden the context.
    return {
      context,
      allowed,
      approved: allowed,
      inherited: false,
      ...(!allowed ? { reason: "Action rejected or revoked" } : {}),
    };
  }
  store.atomic(() => {
    store.db
      .query("UPDATE approvals SET state='expired',version=version+1 WHERE id=? AND state='pending'")
      .run(approvalId);
    store.event(authority.turn.conversation_id, "approval.state", { id: approvalId, state: "expired" });
    store.setTurn(id, "running");
  });
  return deny("Approval expired");
}

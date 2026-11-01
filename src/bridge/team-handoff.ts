import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContextRecord } from "../router/router-db.js";
import { canWithCapabilities } from "../permissions/capability-snapshot.js";
import { bridgeContextCapabilities, bridgeTurnAuthority } from "./authority.js";
import { BridgeError } from "./protocol.js";
import { getBridgeStore, type BridgeStore } from "./store.js";
import { queueMessage } from "./queue.js";

export const handoffInputSchema = z
  .object({
    toAgentId: z.string().min(1).max(80),
    task: z.string().trim().min(1).max(4000),
    done: z.array(z.string().max(1000)).max(20),
    open: z.array(z.string().max(1000)).max(20),
    output: z.string().max(1000).optional(),
  })
  .strict();
export const handoffSchema = handoffInputSchema.extend({
  fromAgentId: z.string(),
  status: z.enum(["pending", "accepted", "cancelled", "expired"]),
});

/** The current team turn may delegate once, inside its signed roster/capabilities. */
export function teamHandoff(
  context: ContextRecord | undefined,
  input: z.infer<typeof handoffInputSchema>,
  store: BridgeStore = getBridgeStore(),
) {
  const parsed = handoffInputSchema.safeParse(input);
  if (!parsed.success) throw new BridgeError("INVALID_REQUEST");
  const turnId = context?.metadata?.bridgeTurnId;
  const authority = typeof turnId === "string" ? bridgeTurnAuthority(turnId, store) : null;
  if (!context || context.kind !== "turn-runtime" || !authority) throw new BridgeError("CONSOLE_TEAM_TURN_REQUIRED");
  const c = store.conversation(authority.turn.conversation_id)!,
    team = store.team(c.id),
    from = store.turnAgent(authority.turn.id) ?? c.agent_id;
  if (
    !team ||
    context.agentId !== from ||
    context.sessionKey !== c.session_key ||
    input.toAgentId === from ||
    !team.members.some((member) => member.kind === "agent" && member.agentId === input.toAgentId) ||
    !authority.grant.agents.some((agent) => agent.id === input.toAgentId) ||
    !canWithCapabilities(bridgeContextCapabilities(context, store), "execute", "group", "sessions")
  )
    throw new BridgeError("NOT_FOUND_OR_DENIED");
  const encoded = JSON.stringify(parsed.data);
  return store.atomic(() => {
    const existing = store.db
      .query<{ message_id: string; turn_id: string; payload: string }, [string]>(
        "SELECT * FROM team_handoffs WHERE parent_turn_id=?",
      )
      .get(authority.turn.id);
    if (existing) {
      if (existing.payload !== encoded) throw new BridgeError("HANDOFF_ALREADY_COMMITTED");
      return { messageId: existing.message_id, turnId: existing.turn_id };
    }
    const parent = store.db
      .query<{ depth: number }, [string]>("SELECT depth FROM team_handoffs WHERE turn_id=?")
      .get(authority.turn.id);
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > 6) throw new BridgeError("HANDOFF_LIMIT");
    const messageId = randomUUID(),
      nextTurnId = randomUUID(),
      createdAt = Date.now();
    const handoff = { ...parsed.data, fromAgentId: from, status: "pending" as const };
    const text = `Handoff from @${from} to @${input.toAgentId}\nTask: ${input.task}\nDone: ${input.done.join("; ")}\nOpen: ${input.open.join("; ")}${input.output ? `\nOutput: ${input.output}` : ""}`;
    store.db
      .query("INSERT INTO messages VALUES (?,?,?,?,?,?)")
      .run(messageId, c.id, "assistant", text, authority.turn.id, createdAt);
    store.db.query("INSERT INTO message_authors VALUES (?,?,?)").run(messageId, from, from);
    store.db
      .query("INSERT INTO team_handoffs VALUES (?,?,?,?,?,?,?)")
      .run(messageId, authority.turn.id, nextTurnId, encoded, JSON.stringify(handoff), depth, "pending");
    store.db.query("INSERT INTO turn_targets VALUES (?,?,?)").run(nextTurnId, input.toAgentId, messageId);
    queueMessage(store, c, authority.grant, messageId, nextTurnId, "after_reply");
    store.event(c.id, "message.finalized", {
      id: messageId,
      role: "assistant",
      text,
      turnId: authority.turn.id,
      createdAt,
      authorId: from,
      authorName: from,
      handoff,
    });
    store.event(c.id, "message.delivery", { id: messageId, delivery: "queued" });
    return { messageId, turnId: nextTurnId };
  });
}

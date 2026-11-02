import { z } from "zod";
import { currentConsoleInvocation, consoleInvocationLive } from "../sdk/gateway/console-context.js";
import { BridgeError } from "./protocol.js";
import { conversationAgentsAllowed } from "./teams.js";
export const desktopWorkSchema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    state: z.enum(["needs_you", "working", "done", "follow_up"]),
    statusLabel: z.string(),
    summary: z.string(),
    updatedAt: z.string(),
    parentId: z.string().optional(),
  }),
);
export function desktopWork(conversationId: string, limit = 100, offset = 0): z.infer<typeof desktopWorkSchema> {
  const invocation = currentConsoleInvocation();
  if (
    !invocation ||
    !consoleInvocationLive(invocation) ||
    invocation.grant.access.resource !== "desktop.work" ||
    invocation.grant.access.action !== "list" ||
    invocation.grant.scope.kind !== "session" ||
    invocation.grant.scope.conversationId !== conversationId
  )
    throw new BridgeError("CONSOLE_AUTHORITY_REQUIRED");
  const { service, grant, enrollment } = invocation,
    c = service.store.authorizedConversation(conversationId, enrollment, grant.sub, grant.projectId);
  if (!conversationAgentsAllowed(service.store, c, grant)) throw new BridgeError("NOT_FOUND_OR_DENIED");
  const rows = service.store.db
    .query<
      {
        id: string;
        status: string;
        text: string;
        agent_id: string | null;
        created_at: number;
        parent_turn_id: string | null;
      },
      [string, number, number]
    >(`SELECT target.turn_id id,COALESCE(t.status,q.state) status,m.text,target.agent_id,COALESCE(t.created_at,q.created_at) created_at,h.parent_turn_id
    FROM turn_targets target JOIN messages m ON m.id=target.message_id
    LEFT JOIN turns t ON t.id=target.turn_id LEFT JOIN queued_messages q ON q.turn_id=target.turn_id
    LEFT JOIN team_handoffs h ON h.turn_id=target.turn_id
    WHERE m.conversation_id=? ORDER BY created_at DESC, target.turn_id DESC LIMIT ? OFFSET ?`)
    .all(conversationId, limit, offset);
  return rows.reverse().map((row) => ({
    id: row.id,
    title: row.text.slice(0, 120),
    state:
      row.status === "awaiting_approval"
        ? "needs_you"
        : ["running", "queued", "pending"].includes(row.status)
          ? "working"
          : "done",
    statusLabel: row.status === "pending" ? "Queued" : row.status.replaceAll("_", " "),
    summary:
      row.status === "failed"
        ? "Request failed. Check the conversation before trying again."
        : row.status === "interrupted_unknown"
          ? "Outcome unconfirmed. Check the conversation before trying again."
          : row.status === "authorization_expired" || row.status === "expired"
            ? "Access expired. Check your access before sending a new request."
            : (row.agent_id ?? c.agent_id),
    updatedAt: new Date(row.created_at).toISOString(),
    ...(row.parent_turn_id ? { parentId: row.parent_turn_id } : {}),
  }));
}

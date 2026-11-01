/** Private execution journal DTOs and service inputs. HTTP commands are declared only
 * in cli/commands/session-conversations.ts; this file is not a transport protocol. */
import type { ConsoleGrant } from "../sdk/gateway/console-contract.js";
export const LEASE_MS = 30_000;
export type BridgeCapability = { permission: string; objectType: string; objectId: string };
export type BridgeGrant = ConsoleGrant;
type Base = { requestId: string; createdAt: number; projectId: string };
type Conversation = { conversationId: string };
export type BridgeRequest = Base &
  (
    | { command: "agents" }
    | { command: "list"; limit?: number; offset?: number }
    | { command: "create"; agentId: string }
    | { command: "team-create"; title: string; agentIds: string[]; personIds: string[] }
    | (Conversation &
        (
          | { command: "open" | "renew" }
          | { command: "history"; before: string | null }
          | {
              command: "send";
              text: string;
              expectedVersion: number;
              barrier?: import("./queue.js").DeliveryBarrier;
              replyTo?: { authorName: string; excerpt: string };
            }
          | { command: "events"; cursor: string | null }
          | { command: "cancel"; turnId: string }
          | {
              command: "decide";
              approvalId: string;
              decision: "approve" | "reject";
              expectedVersion: number;
              actionDigest: string;
            }
        ))
    | { command: "receipt"; targetRequestId: string }
  );
export type BridgeTurnStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "authorization_expired"
  | "interrupted_unknown";
export interface BridgeMessage {
  authorId?: string;
  authorName?: string;
  id: string;
  role: "user" | "assistant";
  text: string;
  turnId: string;
  createdAt: number;
}
export interface BridgeApproval {
  id: string;
  turnId: string;
  capability: BridgeCapability;
  description: string;
  actionDigest: string;
  version: number;
  expiresAt: number;
  state: "pending" | "approved" | "rejected" | "expired" | "invalidated";
}
export interface BridgeTurn {
  agentId?: string;
  id: string;
  status: BridgeTurnStatus;
  cancelRequested: boolean;
}
export interface BridgeConversation {
  team?: BridgeTeam;
  id: string;
  agentId: string;
  title: string;
  version: number;
  updatedAt: number;
}
export interface BridgeTeam {
  ownerAgentId: string;
  members: (
    | { kind: "agent"; agentId: string }
    | { kind: "person"; personId: string; name: string; role: "owner" | "member" }
  )[];
  memory: string[];
}
export interface BridgeSnapshot {
  conversation: BridgeConversation;
  messages: BridgeMessage[];
  hasOlder: boolean;
  turn: BridgeTurn | null;
  approvals: BridgeApproval[];
  cursor: string;
}
export interface BridgeEvent {
  sequence: number;
  type: string;
  data: unknown;
  createdAt: number;
}
export type BridgeResult =
  | { ok: true; requestId: string; data: unknown }
  | { ok: false; requestId: string; error: string; effectState: "none" | "unknown" };
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    readonly effectState: "none" | "unknown" = "none",
  ) {
    super(code);
  }
}

/** Deterministic JSON, shared by the signer and verifier. No user-defined toJSON. */
export function canonicalBridgeJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalBridgeJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalBridgeJson(record[key])}`)
    .join(",")}}`;
}

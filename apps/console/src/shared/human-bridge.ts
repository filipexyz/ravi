/** UI aliases over DTOs generated from the canonical Ravi command return schemas. */
import type {
  SessionsConversationsOpenReturn,
  SessionsConversationsEventsReturn,
} from "./ravi-gateway/types.generated";
export type BridgeSnapshot = SessionsConversationsOpenReturn;
export type BridgeConversation = BridgeSnapshot["conversation"];
export type BridgeMessage = BridgeSnapshot["messages"][number];
export type BridgeApproval = BridgeSnapshot["approvals"][number];
export type BridgeTurn = NonNullable<BridgeSnapshot["turn"]>;
export type BridgeEvent = SessionsConversationsEventsReturn["events"][number];

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

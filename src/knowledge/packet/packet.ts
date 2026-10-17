// STUB (wave A, K-O1). Owner: K-O6. Contract §13.5: the contact packet.
// The signatures below are the contract; the bodies are replaced by the owner
// (who may add fields to ContactPacketDeps).

import type { MessageTarget } from "../../runtime/message-types.js";

export type ContactPacket = { text: string; hash: string; itemIds: string[]; sectionIds: number[]; nonce: string };

export type ContactPacketDeps = Record<string, unknown>;

export function buildContactPacket(
  _input: {
    agentId: string;
    sessionName: string;
    source: MessageTarget | undefined;
    messageText: string;
    now?: number;
  },
  _deps?: ContactPacketDeps,
): ContactPacket | null {
  throw new Error("not implemented: buildContactPacket");
}

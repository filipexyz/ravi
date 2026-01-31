/**
 * Matrix Channel Types
 *
 * Type definitions for Matrix channel integration.
 */

import type { InboundMessage } from "../types.js";

// ============================================================================
// Configuration Types
// ============================================================================

/** Matrix account configuration */
export interface MatrixAccountConfig {
  /** Display name for the account */
  name?: string;

  /** Whether this account is enabled */
  enabled: boolean;

  /** Matrix homeserver URL */
  homeserver: string;

  /** Access token (if using token auth) */
  accessToken?: string;

  /** User ID (optional, can be derived from token) */
  userId?: string;

  /** Password (if using password auth) */
  password?: string;

  /** Enable end-to-end encryption */
  encryption: boolean;

  /** DM policy: how to handle direct messages */
  dmPolicy: "open" | "closed" | "pairing";

  /** List of user IDs allowed to send DMs */
  allowFrom: string[];

  /** Room/group policy */
  roomPolicy: "open" | "closed" | "allowlist";

  /** List of room IDs/aliases allowed */
  roomAllowlist: string[];

  /** Send read receipts */
  sendReadReceipts: boolean;

  /** Debounce time in milliseconds */
  debounceMs: number;
}

/** Main Matrix configuration */
export interface MatrixConfig {
  /** Account configurations keyed by account ID */
  accounts: Record<string, MatrixAccountConfig>;
}

// ============================================================================
// Credentials Types
// ============================================================================

/** Stored Matrix credentials for a single account */
export interface MatrixStoredCredentials {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
}

/** Multi-account credentials storage (keyed by agent ID) */
export interface MatrixCredentialsStore {
  /** Version for future migrations (v3 = agent-based) */
  version: number;
  /** Accounts keyed by agent ID (1:1 agent ↔ account) */
  accounts: Record<string, MatrixStoredCredentials>;
}

// ============================================================================
// Storage Types
// ============================================================================

/** Matrix storage paths */
export interface MatrixStoragePaths {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
  metaPath: string;
  accountKey: string;
  tokenHash: string;
}

// ============================================================================
// Message Types
// ============================================================================

/** Matrix-specific inbound message */
export interface MatrixInbound extends InboundMessage {
  /** Matrix room ID */
  roomId: string;

  /** Matrix event ID */
  eventId: string;

  /** Whether this is a direct message */
  isDirect: boolean;

  /** Thread root event ID (if in a thread) */
  threadId?: string;

  /** Reply-to event ID */
  replyToEventId?: string;
}

/** Matrix message content type */
export type MatrixMsgType = "m.text" | "m.image" | "m.video" | "m.audio" | "m.file";

/** Matrix event types */
export const EventType = {
  RoomMessage: "m.room.message",
  RoomMessageEncrypted: "m.room.encrypted",
  Reaction: "m.reaction",
  Direct: "m.direct",
  Location: "m.location",
} as const;

/** Matrix message types */
export const MsgType = {
  Text: "m.text",
  Image: "m.image",
  Audio: "m.audio",
  Video: "m.video",
  File: "m.file",
} as const;

/** Matrix relation types */
export const RelationType = {
  Thread: "m.thread",
  Replace: "m.replace",
  Annotation: "m.annotation",
} as const;

// ============================================================================
// Event Content Types
// ============================================================================

/** Base Matrix message content */
export interface MatrixTextContent {
  msgtype: "m.text";
  body: string;
  format?: string;
  formatted_body?: string;
  "m.relates_to"?: MatrixRelation;
}

/** Matrix formatted content */
export interface MatrixFormattedContent {
  format?: string;
  formatted_body?: string;
}

/** Matrix relation types */
export type MatrixRelation = MatrixReplyRelation | MatrixThreadRelation;

/** Reply relation */
export interface MatrixReplyRelation {
  "m.in_reply_to": {
    event_id: string;
  };
}

/** Thread relation */
export interface MatrixThreadRelation {
  rel_type: "m.thread";
  event_id: string;
  is_falling_back: boolean;
  "m.in_reply_to": {
    event_id: string;
  };
}

/** Reaction event content */
export interface ReactionEventContent {
  "m.relates_to": {
    rel_type: "m.annotation";
    event_id: string;
    key: string;
  };
}

/** Direct account data (m.direct) */
export interface MatrixDirectAccountData {
  [userId: string]: string[];
}

/** Encrypted file info */
export interface EncryptedFile {
  url: string;
  key: {
    kty: string;
    key_ops: string[];
    alg: string;
    k: string;
    ext: boolean;
  };
  iv: string;
  hashes: Record<string, string>;
  v: string;
}

// ============================================================================
// Raw Event Types
// ============================================================================

/** Raw Matrix event from sync */
export interface MatrixRawEvent {
  type: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
}

/** Room message event content */
export interface RoomMessageEventContent {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
  url?: string;
  file?: EncryptedFile;
  info?: {
    mimetype?: string;
    size?: number;
    duration?: number;
  };
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: {
      event_id: string;
    };
  };
}

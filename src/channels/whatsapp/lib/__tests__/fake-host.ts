/**
 * Test double for `WhatsAppHandlerHost`.
 *
 * Omni's handler tests built a real `WhatsAppPlugin` and patched methods on it.
 * The ravi port tests the handlers against this host instead: identity helpers
 * (`storeLidMapping`, `getLidMappingCache`, `isLidFirstEnabled`, `getMeJid`,
 * `isBotSentMessage`) keep Omni's plugin semantics, every event callback is a
 * `mock()` the test can assert on or replace.
 */

import { mock } from "bun:test";
import { loadBaileys } from "../../baileys-loader.js";
import type { WhatsAppHandlerHost } from "../types.js";

// The handlers read Baileys values through `baileys()`: load it once for every test using this host.
await loadBaileys();

export interface FakeHostOptions {
  lidFirstEnabled?: boolean;
  meJid?: string;
  mediaBaseDir?: string;
}

export function createFakeHost(options: FakeHostOptions = {}) {
  const lidMappingCache = new Map<string, Map<string, string>>();
  const sentMessageIds = new Set<string>();

  const host = {
    // ── identity (Omni plugin.ts semantics) ──────────────────────────
    getMeJid: mock((_instanceId: string): string | undefined => options.meJid),
    storeLidMapping: mock((instanceId: string, lidJid: string, phoneJid: string): void => {
      let cache = lidMappingCache.get(instanceId);
      if (!cache) {
        cache = new Map();
        lidMappingCache.set(instanceId, cache);
      }
      cache.set(lidJid, phoneJid);
      cache.set(phoneJid, lidJid);
    }),
    getLidMappingCache: (instanceId: string): Map<string, string> => lidMappingCache.get(instanceId) ?? new Map(),
    isLidFirstEnabled: (_instanceId: string): boolean => options.lidFirstEnabled ?? true,
    isBotSentMessage: (_instanceId: string, messageId: string): boolean => sentMessageIds.has(messageId),
    getMediaBaseDir: (): string => options.mediaBaseDir ?? "/tmp/ravi-whatsapp-test-media",

    // ── connection ───────────────────────────────────────────────────
    handleQrCode: mock(async (_instanceId: string, _qr: string, _expiresAt: Date) => {}),
    handleConnected: mock(async (..._args: unknown[]) => {}),
    handleDisconnected: mock(async (_instanceId: string, _reason: string, _willReconnect: boolean) => {}),
    handleReconnecting: mock(async (_instanceId: string, _attempt: number, _max: number) => {}),
    handleConnectionError: mock((_instanceId: string, _error: string, _willRetry: boolean) => {}),
    handlePasskeyUpdate: mock(async (..._args: unknown[]) => {}),

    // ── messages ─────────────────────────────────────────────────────
    handleMessageReceived: mock(async (..._args: unknown[]) => {}),
    handleReactionReceived: mock(async (..._args: unknown[]) => {}),
    handleMessageEdited: mock(async (..._args: unknown[]) => {}),
    handleMessageDeleted: mock(async (..._args: unknown[]) => {}),
    handleMessageDelivered: mock(async (..._args: unknown[]) => {}),
    handleMessageRead: mock(async (..._args: unknown[]) => {}),
    handleMessageFailed: mock(async (..._args: unknown[]) => {}),

    // ── all-events ───────────────────────────────────────────────────
    handleCallReceived: mock((..._args: unknown[]) => {}),
    handlePresenceUpdate: mock((..._args: unknown[]) => {}),
    handleChatsUpsert: mock((..._args: unknown[]) => {}),
    handleChatsUpdate: mock((..._args: unknown[]) => {}),
    handleChatsDelete: mock((..._args: unknown[]) => {}),
    handleChatLockUpdate: mock((..._args: unknown[]) => {}),
    handleContactsUpsert: mock((..._args: unknown[]) => {}),
    handleContactsUpdate: mock((..._args: unknown[]) => {}),
    handleGroupsUpsert: mock((..._args: unknown[]) => {}),
    handleGroupsUpdate: mock((..._args: unknown[]) => {}),
    handleGroupParticipantsUpdate: mock((..._args: unknown[]) => {}),
    handleGroupJoinRequest: mock((..._args: unknown[]) => {}),
    handleGroupMemberTagUpdate: mock((..._args: unknown[]) => {}),
    handleMessageReceiptUpdate: mock((..._args: unknown[]) => {}),
    handleMediaUpdate: mock((..._args: unknown[]) => {}),
    handleMessageCappingUpdate: mock((..._args: unknown[]) => {}),
    handleHistorySync: mock(async (..._args: unknown[]) => {}),
    handleMessagingHistoryStatus: mock((..._args: unknown[]) => {}),
    handleBlocklistSet: mock((..._args: unknown[]) => {}),
    handleBlocklistUpdate: mock((..._args: unknown[]) => {}),
    handleSettingsUpdate: mock((..._args: unknown[]) => {}),
    handleLabelEdit: mock((..._args: unknown[]) => {}),
    handleLabelAssociation: mock((..._args: unknown[]) => {}),

    /** Test helper: mark an id as sent by this runtime (echo suppression). */
    trackSent(messageId: string): void {
      sentMessageIds.add(messageId);
    },
  } satisfies WhatsAppHandlerHost & { trackSent(messageId: string): void };

  return host;
}

export type FakeHost = ReturnType<typeof createFakeHost>;

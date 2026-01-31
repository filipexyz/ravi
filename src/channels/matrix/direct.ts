/**
 * Matrix Direct Room Tracker
 *
 * Detects whether a room is a direct message (DM) or a group room.
 */

import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { logger } from "../../utils/logger.js";

const log = logger.child("matrix:direct");

const DM_CACHE_TTL_MS = 30_000;

/**
 * Parameters for DM check
 */
interface DirectMessageCheck {
  roomId: string;
  senderId?: string;
  selfUserId?: string;
}

/**
 * Create a direct room tracker for a Matrix client
 */
export function createDirectRoomTracker(client: MatrixClient) {
  let lastDmUpdateMs = 0;
  let cachedSelfUserId: string | null = null;
  const memberCountCache = new Map<string, { count: number; ts: number }>();

  /**
   * Get the bot's user ID (cached)
   */
  const ensureSelfUserId = async (): Promise<string | null> => {
    if (cachedSelfUserId) return cachedSelfUserId;
    try {
      cachedSelfUserId = await client.getUserId();
    } catch {
      cachedSelfUserId = null;
    }
    return cachedSelfUserId;
  };

  /**
   * Refresh the DM room cache
   */
  const refreshDmCache = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastDmUpdateMs < DM_CACHE_TTL_MS) return;
    lastDmUpdateMs = now;
    try {
      await client.dms.update();
    } catch (err) {
      log.debug(`DM cache refresh failed: ${String(err)}`);
    }
  };

  /**
   * Get member count for a room (cached)
   */
  const resolveMemberCount = async (roomId: string): Promise<number | null> => {
    const cached = memberCountCache.get(roomId);
    const now = Date.now();
    if (cached && now - cached.ts < DM_CACHE_TTL_MS) {
      return cached.count;
    }
    try {
      const members = await client.getJoinedRoomMembers(roomId);
      const count = members.length;
      memberCountCache.set(roomId, { count, ts: now });
      return count;
    } catch (err) {
      log.debug(`Member count failed room=${roomId}: ${String(err)}`);
      return null;
    }
  };

  /**
   * Check if a room has the is_direct flag set for a user
   */
  const hasDirectFlag = async (roomId: string, userId?: string): Promise<boolean> => {
    const target = userId?.trim();
    if (!target) return false;
    try {
      const state = await client.getRoomStateEvent(roomId, "m.room.member", target);
      return state?.is_direct === true;
    } catch {
      return false;
    }
  };

  return {
    /**
     * Check if a room is a direct message
     *
     * Uses multiple heuristics:
     * 1. Check m.direct account data
     * 2. Check member count (2 members = DM)
     * 3. Check is_direct flag in member state
     */
    isDirectMessage: async (params: DirectMessageCheck): Promise<boolean> => {
      const { roomId, senderId } = params;

      // Refresh DM cache periodically
      await refreshDmCache();

      // 1. Check m.direct account data
      if (client.dms.isDm(roomId)) {
        log.debug(`DM detected via m.direct room=${roomId}`);
        return true;
      }

      // 2. Check member count (2 members = likely DM)
      const memberCount = await resolveMemberCount(roomId);
      if (memberCount === 2) {
        log.debug(`DM detected via member count room=${roomId} members=${memberCount}`);
        return true;
      }

      // 3. Check is_direct flag in member state
      const selfUserId = params.selfUserId ?? (await ensureSelfUserId());
      const directViaState =
        (await hasDirectFlag(roomId, senderId)) ||
        (await hasDirectFlag(roomId, selfUserId ?? ""));
      if (directViaState) {
        log.debug(`DM detected via member state room=${roomId}`);
        return true;
      }

      log.debug(`Room check room=${roomId} result=group members=${memberCount ?? "unknown"}`);
      return false;
    },

    /**
     * Clear the cache
     */
    clearCache: (): void => {
      memberCountCache.clear();
      lastDmUpdateMs = 0;
    },
  };
}

export type DirectRoomTracker = ReturnType<typeof createDirectRoomTracker>;

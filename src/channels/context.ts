/**
 * Stable presentation metadata persisted for reply routing. Actor identity is
 * deliberately excluded and must never be reconstructed from this snapshot.
 */
export interface ChannelContext {
  channelId: string;
  channelName: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  botTag?: string;
}

/**
 * Copy only the persisted channel fields at the storage boundary. Callers may
 * pass a richer message context, but actor and message identity never survive.
 */
export function toPersistedChannelContext(context: ChannelContext): ChannelContext {
  return {
    channelId: context.channelId,
    channelName: context.channelName,
    isGroup: context.isGroup,
    ...(context.groupName !== undefined ? { groupName: context.groupName } : {}),
    ...(context.groupId !== undefined ? { groupId: context.groupId } : {}),
    ...(context.groupMembers !== undefined ? { groupMembers: [...context.groupMembers] } : {}),
    ...(context.botTag !== undefined ? { botTag: context.botTag } : {}),
  };
}

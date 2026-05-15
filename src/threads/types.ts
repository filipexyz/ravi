export type ThreadStatus = "open" | "waiting" | "blocked" | "resolved" | "closed" | (string & {});

export type ThreadEntryKind =
  | "note"
  | "comment"
  | "prompt"
  | "answer"
  | "decision"
  | "summary"
  | "question"
  | "open_loop"
  | "source_ref"
  | "handoff_note"
  | "status_change"
  | "observer_comment"
  | "system"
  | (string & {});

export type ThreadVisibility = "default" | "internal" | "private" | "restricted" | (string & {});

export interface ThreadPointer {
  type: string;
  id?: string;
}

export interface ThreadActor {
  type: string;
  id?: string;
  name?: string;
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
  contextId?: string;
}

export interface ThreadRecord {
  id: string;
  slug?: string;
  title: string;
  summary?: string;
  status: ThreadStatus;
  ownerType: string;
  ownerId?: string;
  scopeType: string;
  scopeId?: string;
  defaultAgentId?: string;
  defaultChatId?: string;
  defaultContactId?: string;
  currentAssigneeType?: string;
  currentAssigneeId?: string;
  closedReason?: string;
  closedAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastEntryAt?: number;
  lastHandoffAt?: number;
}

export interface ThreadEntryRecord {
  id: string;
  threadId: string;
  kind: ThreadEntryKind;
  body: string;
  summary?: string;
  actorType: string;
  actorId?: string;
  actorName?: string;
  actorAgentId?: string;
  actorSessionKey?: string;
  actorSessionName?: string;
  sourceType: string;
  sourceId?: string;
  sourceMessageId?: string;
  sourceSessionKey?: string;
  sourceChatId?: string;
  visibility: ThreadVisibility;
  importance?: string;
  pinned: boolean;
  sourcePolicy?: string;
  resolvedAt?: number;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadLinkRecord {
  id: string;
  threadId: string;
  targetType: string;
  targetId: string;
  role: string;
  label?: string;
  visibility: ThreadVisibility;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadHandoffRecord {
  id: string;
  threadId: string;
  sourceSessionKey?: string;
  sourceSessionName?: string;
  targetSessionKey: string;
  targetSessionName?: string;
  targetAgentId?: string;
  handoffKind: string;
  sourceEntryId?: string;
  briefText: string;
  brief?: ThreadBrief;
  includedEntryIds: string[];
  includedLinkIds: string[];
  snapshotHash?: string;
  snapshotVersion?: string;
  status: "queued" | "delivered" | "failed" | (string & {});
  createdThread: boolean;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
  failedAt?: number;
  failureReason?: string;
}

export interface ThreadBrief {
  thread: Pick<
    ThreadRecord,
    "id" | "slug" | "title" | "summary" | "status" | "scopeType" | "scopeId" | "ownerType" | "ownerId"
  >;
  entries: Array<{
    id: string;
    kind: ThreadEntryKind;
    body: string;
    actorType: string;
    actorName?: string;
    actorAgentId?: string;
    actorSessionName?: string;
    createdAt: number;
  }>;
  links: Array<{
    id: string;
    targetType: string;
    targetId: string;
    role: string;
    label?: string;
  }>;
  omitted: {
    privateEntries: number;
    privateLinks: number;
    olderEntries: number;
    charBudgetExceeded: boolean;
  };
  text: string;
  snapshotHash: string;
  snapshotVersion: string;
}

export interface ThreadHandoffPromptMetadata {
  id: string;
  handoffId: string;
  slug?: string;
  title: string;
  status: ThreadStatus;
  scope: ThreadPointer;
  owner: ThreadPointer;
  createdThread: boolean;
  sourceEntryId?: string;
  brief: {
    snapshotHash: string;
    snapshotVersion: string;
    includedEntryIds: string[];
    includedLinkIds: string[];
    omitted: ThreadBrief["omitted"];
  };
}

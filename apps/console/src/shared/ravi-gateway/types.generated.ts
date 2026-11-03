// GENERATED FILE — DO NOT EDIT.
// Run `ravi sdk client generate` to regenerate.
// Drift is detected by `ravi sdk client check` (CI).

/** Input shape for `sessions.conversations.team-create`. */
export type SessionsConversationsTeamCreateInput = {
  agentIds: string[];
  createdAt: number;
  personIds: string[];
  projectId: string;
  requestId: string;
  title: string;
};

/** Return shape for `sessions.conversations.team-create`. */
export type SessionsConversationsTeamCreateReturn = {
  conversation: {
    agentId: string;
    id: string;
    team?: {
      members: Array<({
        agentId: string;
        kind: "agent";
      }) | ({
        kind: "person";
        name: string;
        personId: string;
        role: "owner" | "member";
      })>;
      memory: string[];
      ownerAgentId: string;
    };
    title: string;
    updatedAt: number;
    version: number;
  };
  conversationId: string;
};

/** Input shape for `sessions.conversations.agents`. */
export type SessionsConversationsAgentsInput = {
  createdAt: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.agents`. */
export type SessionsConversationsAgentsReturn = Array<{
  id: string;
  name: string;
}>;

/** Input shape for `sessions.conversations.list`. */
export type SessionsConversationsListInput = {
  createdAt: number;
  limit?: number;
  offset?: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.list`. */
export type SessionsConversationsListReturn = Array<{
  agentId: string;
  id: string;
  team?: {
    members: Array<({
      agentId: string;
      kind: "agent";
    }) | ({
      kind: "person";
      name: string;
      personId: string;
      role: "owner" | "member";
    })>;
    memory: string[];
    ownerAgentId: string;
  };
  title: string;
  updatedAt: number;
  version: number;
}>;

/** Input shape for `sessions.conversations.create`. */
export type SessionsConversationsCreateInput = {
  agentId: string;
  createdAt: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.create`. */
export type SessionsConversationsCreateReturn = {
  conversation: {
    agentId: string;
    id: string;
    team?: {
      members: Array<({
        agentId: string;
        kind: "agent";
      }) | ({
        kind: "person";
        name: string;
        personId: string;
        role: "owner" | "member";
      })>;
      memory: string[];
      ownerAgentId: string;
    };
    title: string;
    updatedAt: number;
    version: number;
  };
  conversationId: string;
};

/** Input shape for `sessions.conversations.open`. */
export type SessionsConversationsOpenInput = {
  conversationId: string;
  createdAt: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.open`. */
export type SessionsConversationsOpenReturn = {
  approvals: Array<{
    actionDigest: string;
    capability: {
      objectId: string;
      objectType: string;
      permission: string;
    };
    description: string;
    expiresAt: number;
    id: string;
    state: "pending" | "approved" | "rejected" | "expired" | "invalidated";
    turnId: string;
    version: number;
  }>;
  conversation: {
    agentId: string;
    id: string;
    team?: {
      members: Array<({
        agentId: string;
        kind: "agent";
      }) | ({
        kind: "person";
        name: string;
        personId: string;
        role: "owner" | "member";
      })>;
      memory: string[];
      ownerAgentId: string;
    };
    title: string;
    updatedAt: number;
    version: number;
  };
  cursor: string;
  hasOlder: boolean;
  messages: Array<{
    authorId?: string;
    authorName?: string;
    barrier?: "after_tool" | "after_reply" | "after_task" | "record_only";
    createdAt: number;
    delivery?: "sent" | "queued" | "recorded" | "cancelled" | "expired";
    handoff?: {
      done: string[];
      fromAgentId: string;
      open: string[];
      output?: string;
      status: "pending" | "accepted" | "cancelled" | "expired";
      task: string;
      toAgentId: string;
    };
    id: string;
    replyTo?: {
      authorName: string;
      excerpt: string;
    };
    requestId?: string;
    role: "user" | "assistant";
    text: string;
    turnId: string;
  }>;
  turn: ({
    agentId?: string;
    cancelRequested: boolean;
    id: string;
    status: "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "authorization_expired" | "interrupted_unknown";
  }) | null;
};

/** Input shape for `sessions.conversations.history`. */
export type SessionsConversationsHistoryInput = {
  before: string | null;
  conversationId: string;
  createdAt: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.history`. */
export type SessionsConversationsHistoryReturn = {
  hasOlder: boolean;
  messages: Array<{
    authorId?: string;
    authorName?: string;
    barrier?: "after_tool" | "after_reply" | "after_task" | "record_only";
    createdAt: number;
    delivery?: "sent" | "queued" | "recorded" | "cancelled" | "expired";
    handoff?: {
      done: string[];
      fromAgentId: string;
      open: string[];
      output?: string;
      status: "pending" | "accepted" | "cancelled" | "expired";
      task: string;
      toAgentId: string;
    };
    id: string;
    replyTo?: {
      authorName: string;
      excerpt: string;
    };
    requestId?: string;
    role: "user" | "assistant";
    text: string;
    turnId: string;
  }>;
};

/** Input shape for `sessions.conversations.send`. */
export type SessionsConversationsSendInput = {
  barrier?: "after_tool" | "after_reply" | "after_task" | "record_only";
  conversationId: string;
  createdAt: number;
  expectedVersion: number;
  projectId: string;
  replyTo?: {
    authorName: string;
    excerpt: string;
  };
  requestId: string;
  text: string;
};

/** Return shape for `sessions.conversations.send`. */
export type SessionsConversationsSendReturn = {
  accepted: true;
  conversationId: string;
  delivery?: "sent" | "queued" | "recorded" | "cancelled" | "expired";
  messageId: string;
  turnId: string;
  version: number;
};

/** Input shape for `sessions.conversations.events`. */
export type SessionsConversationsEventsInput = {
  conversationId: string;
  createdAt: number;
  cursor: string | null;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.events`. */
export type SessionsConversationsEventsReturn = {
  cursor: string;
  events: Array<({
    createdAt: number;
    data: {
      id: string;
      status: "pending" | "accepted" | "cancelled" | "expired";
    };
    sequence: number;
    type: "handoff.state";
  }) | ({
    createdAt: number;
    data: {
      delivery: "sent" | "queued" | "recorded" | "cancelled" | "expired";
      id: string;
    };
    sequence: number;
    type: "message.delivery";
  }) | ({
    createdAt: number;
    data: {
      authorId?: string;
      authorName?: string;
      barrier?: "after_tool" | "after_reply" | "after_task" | "record_only";
      createdAt: number;
      delivery?: "sent" | "queued" | "recorded" | "cancelled" | "expired";
      handoff?: {
        done: string[];
        fromAgentId: string;
        open: string[];
        output?: string;
        status: "pending" | "accepted" | "cancelled" | "expired";
        task: string;
        toAgentId: string;
      };
      id: string;
      replyTo?: {
        authorName: string;
        excerpt: string;
      };
      requestId?: string;
      role: "user" | "assistant";
      text: string;
      turnId: string;
    };
    sequence: number;
    type: "message.accepted";
  }) | ({
    createdAt: number;
    data: {
      authorId?: string;
      authorName?: string;
      barrier?: "after_tool" | "after_reply" | "after_task" | "record_only";
      createdAt: number;
      delivery?: "sent" | "queued" | "recorded" | "cancelled" | "expired";
      handoff?: {
        done: string[];
        fromAgentId: string;
        open: string[];
        output?: string;
        status: "pending" | "accepted" | "cancelled" | "expired";
        task: string;
        toAgentId: string;
      };
      id: string;
      replyTo?: {
        authorName: string;
        excerpt: string;
      };
      requestId?: string;
      role: "user" | "assistant";
      text: string;
      turnId: string;
    };
    sequence: number;
    type: "message.finalized";
  }) | ({
    createdAt: number;
    data: {
      agentId?: string;
      cancelRequested: boolean;
      id: string;
      status: "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "authorization_expired" | "interrupted_unknown";
    };
    sequence: number;
    type: "turn.state";
  }) | ({
    createdAt: number;
    data: {
      status: string;
      turnId: string;
    };
    sequence: number;
    type: "turn.activity";
  }) | ({
    createdAt: number;
    data: {
      turnId: string;
    };
    sequence: number;
    type: "cancel.requested";
  }) | ({
    createdAt: number;
    data: {
      actionDigest: string;
      capability: {
        objectId: string;
        objectType: string;
        permission: string;
      };
      description: string;
      expiresAt: number;
      id: string;
      state: "pending" | "approved" | "rejected" | "expired" | "invalidated";
      turnId: string;
      version: number;
    };
    sequence: number;
    type: "approval.opened";
  }) | ({
    createdAt: number;
    data: {
      id: string;
      state: "approved" | "rejected" | "expired" | "invalidated";
      version?: number;
    };
    sequence: number;
    type: "approval.state";
  })>;
};

/** Input shape for `sessions.conversations.renew`. */
export type SessionsConversationsRenewInput = {
  conversationId: string;
  createdAt: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.renew`. */
export type SessionsConversationsRenewReturn = {
  conversationId: string;
  renewed: boolean;
};

/** Input shape for `sessions.conversations.cancel`. */
export type SessionsConversationsCancelInput = {
  conversationId: string;
  createdAt: number;
  projectId: string;
  requestId: string;
  turnId: string;
};

/** Return shape for `sessions.conversations.cancel`. */
export type SessionsConversationsCancelReturn = {
  cancelRequested: boolean;
  conversationId: string;
  status: "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "authorization_expired" | "interrupted_unknown";
  turnId: string;
};

/** Input shape for `sessions.conversations.decide`. */
export type SessionsConversationsDecideInput = {
  actionDigest: string;
  approvalId: string;
  conversationId: string;
  createdAt: number;
  decision: "approve" | "reject";
  expectedVersion: number;
  projectId: string;
  requestId: string;
};

/** Return shape for `sessions.conversations.decide`. */
export type SessionsConversationsDecideReturn = {
  approvalId: string;
  conversationId: string;
  state: "approved" | "rejected";
  version: number;
};

/** Input shape for `sessions.conversations.receipt`. */
export type SessionsConversationsReceiptInput = {
  createdAt: number;
  projectId: string;
  requestId: string;
  targetRequestId: string;
};

/** Return shape for `sessions.conversations.receipt`. */
export type SessionsConversationsReceiptReturn = ({
  conversation: {
    agentId: string;
    id: string;
    team?: {
      members: Array<({
        agentId: string;
        kind: "agent";
      }) | ({
        kind: "person";
        name: string;
        personId: string;
        role: "owner" | "member";
      })>;
      memory: string[];
      ownerAgentId: string;
    };
    title: string;
    updatedAt: number;
    version: number;
  };
  conversationId: string;
}) | ({
  accepted: true;
  conversationId: string;
  delivery?: "sent" | "queued" | "recorded" | "cancelled" | "expired";
  messageId: string;
  turnId: string;
  version: number;
}) | ({
  cancelRequested: boolean;
  conversationId: string;
  status: "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "authorization_expired" | "interrupted_unknown";
  turnId: string;
}) | ({
  approvalId: string;
  conversationId: string;
  state: "approved" | "rejected";
  version: number;
});

/** Input shape for `desktop.work.list`. */
export type DesktopWorkListInput = {
  conversationId: string;
  limit?: number;
  offset?: number;
};

/** Return shape for `desktop.work.list`. */
export type DesktopWorkListReturn = Array<{
  id: string;
  parentId?: string;
  state: "needs_you" | "working" | "done" | "follow_up";
  statusLabel: string;
  summary: string;
  title: string;
  updatedAt: string;
}>;

/** Input shape for `desktop.session.read`. */
export type DesktopSessionReadInput = {
  conversationId: string;
};

/** Return shape for `desktop.session.read`. */
export type DesktopSessionReadReturn = {
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  model: string;
  models: Array<{
    id: string;
    label: string;
  }>;
  provider: string;
};

/** Input shape for `desktop.session.configure`. */
export type DesktopSessionConfigureInput = {
  conversationId: string;
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  model: string;
};

/** Return shape for `desktop.session.configure`. */
export type DesktopSessionConfigureReturn = {
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  model: string;
  models: Array<{
    id: string;
    label: string;
  }>;
  provider: string;
};

/** Input shape for `desktop.computer.read`. */
export type DesktopComputerReadInput = {
  conversationId: string;
};

/** Return shape for `desktop.computer.read`. */
export type DesktopComputerReadReturn = {
  branch: string;
  changes: Array<{
    additions: number;
    change: "M" | "A" | "D";
    deletions: number;
    path: string;
  }>;
  cpu: number;
  cwd: string;
  host: string;
  memory: number;
  os: string;
  processes: Array<{
    detail: string;
    id: string;
    name: string;
    status: "running" | "idle" | "failed";
  }>;
  terminal: string[];
  uptime: string;
};

/** Input shape for `desktop.loops.list`. */
export type DesktopLoopsListInput = {
  limit?: number;
  offset?: number;
};

/** Return shape for `desktop.loops.list`. */
export type DesktopLoopsListReturn = Array<{
  enabled: boolean;
  id: string;
  kind: "cron" | "trigger" | "heartbeat";
  lastResult: "ok" | "failed" | "skipped" | "never" | "unknown";
  lastRunAt?: string;
  name: string;
  nextRunAt?: string;
  schedule: string;
}>;

/** Input shape for `desktop.loops.set-enabled`. */
export type DesktopLoopsSetEnabledInput = {
  enabled: boolean;
  id: string;
};

/** Return shape for `desktop.loops.set-enabled`. */
export type DesktopLoopsSetEnabledReturn = Array<{
  enabled: boolean;
  id: string;
  kind: "cron" | "trigger" | "heartbeat";
  lastResult: "ok" | "failed" | "skipped" | "never" | "unknown";
  lastRunAt?: string;
  name: string;
  nextRunAt?: string;
  schedule: string;
}>;

/** Input shape for `desktop.channels.list`. */
export type DesktopChannelsListInput = {
  limit?: number;
  offset?: number;
};

/** Return shape for `desktop.channels.list`. */
export type DesktopChannelsListReturn = Array<{
  enabled: boolean;
  id: string;
  name: string;
  provider: string;
  status: "disabled" | "unknown" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
}>;

/** Input shape for `desktop.channels.set-enabled`. */
export type DesktopChannelsSetEnabledInput = {
  enabled: boolean;
  id: string;
};

/** Return shape for `desktop.channels.set-enabled`. */
export type DesktopChannelsSetEnabledReturn = Array<{
  enabled: boolean;
  id: string;
  name: string;
  provider: string;
  status: "disabled" | "unknown" | "starting" | "connected" | "degraded" | "reconnecting" | "disconnected" | "failed";
}>;

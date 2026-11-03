import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
  recordAgentInboxItem,
  type AgentInboxDbExecutor,
} from "@/server/console/agent-inbox";
import type { BugReportPriority, BugReportStatus } from "@/server/console/bug-reports";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

export const BUG_STATUS_FOLLOW_EVENT_TYPE = "watch.console.bug.status";
export const BUG_STATUS_FOLLOW_CATEGORY = "system";
export const BUG_STATUS_FOLLOW_SOURCE_TYPE = "bug_report";

const uuidSchema = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BugStatusFollowPayload = {
  bugId: string;
  status: BugReportStatus;
  previousStatus: BugReportStatus;
  title: string;
  consoleUrl: string;
  reporterUserId: string;
  priority?: BugReportPriority;
};

export type BugReportSubscriptionRow = {
  id: string;
  bugReportId: string;
  localInstallationId: string;
  userId: string;
  organizationId: string | null;
  projectId: string | null;
  createdAt: Date;
};

export type BugStatusFollowBug = {
  id: string;
  title: string;
  status: BugReportStatus;
  priority: BugReportPriority | null;
  reporterUserId: string;
  organizationId: string | null;
  projectId: string | null;
  statusUpdatedAt: Date;
};

export type BugStatusFollowInboxInsert = typeof schema.agentInboxItems.$inferInsert;

export type BugReportFollowStore = {
  findVisibleBug(input: {
    id: string;
    reporterUserId: string;
  }): Promise<BugStatusFollowBug | null>;
  upsertSubscription(input: {
    bug: BugStatusFollowBug;
    localInstallationId: string;
    userId: string;
    organizationId: string | null;
    projectId: string | null;
  }): Promise<BugReportSubscriptionRow>;
  deleteSubscription(input: {
    bugReportId: string;
    localInstallationId: string;
  }): Promise<boolean>;
  listSubscriptions(bugReportId: string): Promise<BugReportSubscriptionRow[]>;
  recordInboxItem(
    item: BugStatusFollowInboxInsert,
  ): Promise<{ id: string } | null>;
  deleteBug(bugReportId: string): Promise<void>;
};

export type BugReportFollowSubscription = {
  id: string;
  bugId: string;
  localInstallationId: string;
  userId: string;
  organizationId: string | null;
  projectId: string | null;
  createdAt: number;
  subscribed: true;
};

export function shouldEmitBugStatusFollow(
  previousStatus: BugReportStatus,
  nextStatus: BugReportStatus,
) {
  return previousStatus !== nextStatus;
}

export function bugStatusFollowSeverity(status: BugReportStatus) {
  if (status === "resolved") return "success" as const;
  if (status === "wontfix" || status === "duplicate") return "warning" as const;
  return "info" as const;
}

export function bugStatusFollowDedupeKey(input: {
  bugId: string;
  localInstallationId: string;
  previousStatus: BugReportStatus;
  status: BugReportStatus;
  statusUpdatedAt: Date;
}) {
  return [
    "watch:console.bug.status",
    input.bugId,
    input.localInstallationId,
    input.previousStatus,
    input.status,
    input.statusUpdatedAt.toISOString(),
  ].join(":");
}

export function buildBugStatusFollowPayload(input: {
  bug: BugStatusFollowBug;
  previousStatus: BugReportStatus;
}): BugStatusFollowPayload {
  const payload: BugStatusFollowPayload = {
    bugId: input.bug.id,
    status: input.bug.status,
    previousStatus: input.previousStatus,
    title: input.bug.title,
    consoleUrl: followConsoleUrl(input.bug.id),
    reporterUserId: input.bug.reporterUserId,
  };
  if (input.bug.priority) payload.priority = input.bug.priority;
  return payload;
}

export function buildBugStatusFollowInboxItem(input: {
  bug: BugStatusFollowBug;
  previousStatus: BugReportStatus;
  subscription: Pick<
    BugReportSubscriptionRow,
    "localInstallationId" | "organizationId" | "projectId"
  >;
}): BugStatusFollowInboxInsert | null {
  const organizationId = input.subscription.organizationId ?? input.bug.organizationId;
  if (!organizationId) return null;

  const payload = buildBugStatusFollowPayload({
    bug: input.bug,
    previousStatus: input.previousStatus,
  });
  const payloadJson = payload as unknown as JsonRecord;

  return {
    organizationId,
    projectId: input.subscription.projectId ?? input.bug.projectId,
    sourceType: BUG_STATUS_FOLLOW_SOURCE_TYPE,
    sourceId: input.bug.id,
    eventType: BUG_STATUS_FOLLOW_EVENT_TYPE,
    category: BUG_STATUS_FOLLOW_CATEGORY,
    severity: bugStatusFollowSeverity(input.bug.status),
    sensitivity: "metadata",
    title: "Bug status updated",
    summary: `"${input.bug.title}" is now ${input.bug.status} (was ${input.previousStatus}).`,
    actorType: "system",
    actorId: null,
    targetType: AGENT_INBOX_TARGET_LOCAL_INSTALLATION,
    targetId: input.subscription.localInstallationId,
    dedupeKey: bugStatusFollowDedupeKey({
      bugId: input.bug.id,
      localInstallationId: input.subscription.localInstallationId,
      previousStatus: input.previousStatus,
      status: input.bug.status,
      statusUpdatedAt: input.bug.statusUpdatedAt,
    }),
    payloadJson,
    linksJson: [{ label: "Console", url: payload.consoleUrl }] as unknown as JsonRecord,
    occurredAt: input.bug.statusUpdatedAt,
  };
}

export async function fanoutBugStatusFollow(input: {
  bug: BugStatusFollowBug;
  previousStatus: BugReportStatus;
  requestId: string;
  store: BugReportFollowStore;
}): Promise<{ emitted: number; skipped: number }> {
  if (!shouldEmitBugStatusFollow(input.previousStatus, input.bug.status)) {
    return { emitted: 0, skipped: 0 };
  }

  const subscriptions = await input.store.listSubscriptions(input.bug.id);
  let emitted = 0;
  let skipped = 0;

  for (const subscription of subscriptions) {
    const item = buildBugStatusFollowInboxItem({
      bug: input.bug,
      previousStatus: input.previousStatus,
      subscription,
    });
    if (!item) {
      skipped += 1;
      continue;
    }
    const recorded = await input.store.recordInboxItem(item);
    if (recorded) emitted += 1;
    else skipped += 1;
  }

  return { emitted, skipped };
}

export async function subscribeBugReportFollow(
  input: {
    id: string;
    reporterUserId: string;
    localInstallationId: string;
    organizationId: string | null;
    projectId?: string | null;
  },
  store: BugReportFollowStore = liveBugReportFollowStore,
): Promise<BugReportFollowSubscription> {
  assertUuid(input.id, "id");
  assertUuid(input.localInstallationId, "localInstallationId");

  const bug = await store.findVisibleBug({
    id: input.id,
    reporterUserId: input.reporterUserId,
  });
  if (!bug) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  const row = await store.upsertSubscription({
    bug,
    localInstallationId: input.localInstallationId,
    userId: input.reporterUserId,
    organizationId: input.organizationId ?? bug.organizationId,
    projectId: input.projectId ?? bug.projectId,
  });

  return toSubscriptionResponse(row);
}

export async function unsubscribeBugReportFollow(
  input: {
    id: string;
    reporterUserId: string;
    localInstallationId: string;
  },
  store: BugReportFollowStore = liveBugReportFollowStore,
): Promise<{ bugId: string; localInstallationId: string; unsubscribed: true }> {
  assertUuid(input.id, "id");
  assertUuid(input.localInstallationId, "localInstallationId");

  const bug = await store.findVisibleBug({
    id: input.id,
    reporterUserId: input.reporterUserId,
  });
  if (!bug) {
    throw new ConsoleApiError(404, { error: "not_found" });
  }

  await store.deleteSubscription({
    bugReportId: bug.id,
    localInstallationId: input.localInstallationId,
  });

  return {
    bugId: bug.id,
    localInstallationId: input.localInstallationId,
    unsubscribed: true,
  };
}

export async function emitBugStatusFollow(input: {
  bug: BugStatusFollowBug;
  previousStatus: BugReportStatus;
  requestId: string;
  tx?: AgentInboxDbExecutor;
}) {
  const store = input.tx ? transactionalFollowStore(input.tx) : liveBugReportFollowStore;
  return fanoutBugStatusFollow({
    bug: input.bug,
    previousStatus: input.previousStatus,
    requestId: input.requestId,
    store,
  });
}

export function createMemoryBugReportFollowStore(seed?: {
  bugs?: BugStatusFollowBug[];
  subscriptions?: BugReportSubscriptionRow[];
}): BugReportFollowStore & {
  bugs: Map<string, BugStatusFollowBug>;
  subscriptions: Map<string, BugReportSubscriptionRow>;
  inboxItems: BugStatusFollowInboxInsert[];
} {
  const bugs = new Map((seed?.bugs ?? []).map((bug) => [bug.id, bug]));
  const subscriptions = new Map(
    (seed?.subscriptions ?? []).map((row) => [subscriptionKey(row.bugReportId, row.localInstallationId), row]),
  );
  const inboxItems: BugStatusFollowInboxInsert[] = [];

  const store: BugReportFollowStore & {
    bugs: Map<string, BugStatusFollowBug>;
    subscriptions: Map<string, BugReportSubscriptionRow>;
    inboxItems: BugStatusFollowInboxInsert[];
  } = {
    bugs,
    subscriptions,
    inboxItems,
    async findVisibleBug({ id, reporterUserId }) {
      const bug = bugs.get(id);
      if (!bug || bug.reporterUserId !== reporterUserId) return null;
      return bug;
    },
    async upsertSubscription(input) {
      const key = subscriptionKey(input.bug.id, input.localInstallationId);
      const existing = subscriptions.get(key);
      if (existing) {
        const next = {
          ...existing,
          organizationId: input.organizationId,
          projectId: input.projectId,
        };
        subscriptions.set(key, next);
        return next;
      }
      const created: BugReportSubscriptionRow = {
        id: randomUUID(),
        bugReportId: input.bug.id,
        localInstallationId: input.localInstallationId,
        userId: input.userId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        createdAt: new Date(),
      };
      subscriptions.set(key, created);
      return created;
    },
    async deleteSubscription(input) {
      return subscriptions.delete(subscriptionKey(input.bugReportId, input.localInstallationId));
    },
    async listSubscriptions(bugReportId) {
      return [...subscriptions.values()].filter((row) => row.bugReportId === bugReportId);
    },
    async recordInboxItem(item) {
      inboxItems.push(item);
      return { id: randomUUID() };
    },
    async deleteBug(bugReportId) {
      bugs.delete(bugReportId);
      for (const key of [...subscriptions.keys()]) {
        if (key.startsWith(`${bugReportId}:`)) subscriptions.delete(key);
      }
    },
  };

  return store;
}

const liveBugReportFollowStore: BugReportFollowStore = {
  async findVisibleBug({ id, reporterUserId }) {
    const [row] = await db.select().from(schema.bugReports).where(eq(schema.bugReports.id, id)).limit(1);
    if (!row || row.reporterUserId !== reporterUserId) return null;
    return toFollowBug(row);
  },
  async upsertSubscription(input) {
    const [row] = await db
      .insert(schema.bugReportSubscriptions)
      .values({
        bugReportId: input.bug.id,
        localInstallationId: input.localInstallationId,
        userId: input.userId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      })
      .onConflictDoUpdate({
        target: [
          schema.bugReportSubscriptions.bugReportId,
          schema.bugReportSubscriptions.localInstallationId,
        ],
        set: {
          organizationId: input.organizationId,
          projectId: input.projectId,
        },
      })
      .returning();
    if (!row) throw new Error("Failed to store bug report subscription.");
    return row;
  },
  async deleteSubscription(input) {
    const deleted = await db
      .delete(schema.bugReportSubscriptions)
      .where(
        and(
          eq(schema.bugReportSubscriptions.bugReportId, input.bugReportId),
          eq(schema.bugReportSubscriptions.localInstallationId, input.localInstallationId),
        ),
      )
      .returning({ id: schema.bugReportSubscriptions.id });
    return deleted.length > 0;
  },
  async listSubscriptions(bugReportId) {
    return db
      .select()
      .from(schema.bugReportSubscriptions)
      .where(eq(schema.bugReportSubscriptions.bugReportId, bugReportId));
  },
  async recordInboxItem(item) {
    const recorded = await recordAgentInboxItem(item);
    return recorded ? { id: recorded.id } : null;
  },
  async deleteBug(bugReportId) {
    await db.delete(schema.bugReports).where(eq(schema.bugReports.id, bugReportId));
  },
};

function transactionalFollowStore(tx: AgentInboxDbExecutor): BugReportFollowStore {
  return {
    ...liveBugReportFollowStore,
    async listSubscriptions(bugReportId) {
      return tx
        .select()
        .from(schema.bugReportSubscriptions)
        .where(eq(schema.bugReportSubscriptions.bugReportId, bugReportId));
    },
    async recordInboxItem(item) {
      const recorded = await recordAgentInboxItem(item, tx);
      return recorded ? { id: recorded.id } : null;
    },
  };
}

function toFollowBug(row: typeof schema.bugReports.$inferSelect): BugStatusFollowBug {
  return {
    id: row.id,
    title: row.title,
    status: row.status as BugReportStatus,
    priority: row.priority as BugReportPriority | null,
    reporterUserId: row.reporterUserId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    statusUpdatedAt: row.statusUpdatedAt,
  };
}

function toSubscriptionResponse(row: BugReportSubscriptionRow): BugReportFollowSubscription {
  return {
    id: row.id,
    bugId: row.bugReportId,
    localInstallationId: row.localInstallationId,
    userId: row.userId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    createdAt: row.createdAt.getTime(),
    subscribed: true,
  };
}

function subscriptionKey(bugReportId: string, localInstallationId: string) {
  return `${bugReportId}:${localInstallationId}`;
}

function followConsoleUrl(id: string) {
  const baseUrl =
    process.env.NEXT_PUBLIC_CONSOLE_URL?.trim().replace(/\/$/, "") || "https://console.ravi.bot";
  return `${baseUrl}/bugs/${id}`;
}

function assertUuid(value: string, field: string) {
  if (!uuidSchema.test(value)) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { [field]: "Invalid id" },
    });
  }
}

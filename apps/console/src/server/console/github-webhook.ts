import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import { cliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { recordAgentInboxItem } from "./agent-inbox";
import { syncGithubAppInstallationWebhook } from "./github-app";

export type GithubWebhookEvent = {
  eventType: string;
  payload: JsonRecord;
  severity: "info" | "success" | "warning" | "error" | "action_required";
  summary: string;
  title: string;
  githubUrl: string | null;
  occurredAt: Date;
};

export type GithubWebhookProcessResult = {
  deliveryId: string;
  duplicate: boolean;
  inboxItemIds: string[];
  matchedWatchIds: string[];
  normalizedEventType: string | null;
  status: "matched" | "ignored";
};

type GithubWebhookPayload = Record<string, unknown>;

export function getGithubWebhookSecret() {
  return process.env.RAVI_GITHUB_WEBHOOK_SECRET?.trim() || process.env.GITHUB_WEBHOOK_SECRET?.trim() || null;
}

export function verifyGithubWebhookSignature(input: {
  body: string;
  secret: string;
  signature: string | null;
}) {
  if (!input.signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", input.secret)
    .update(Buffer.from(input.body, "utf8"))
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(input.signature, "utf8");
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function parseGithubWebhookBody(body: string): GithubWebhookPayload {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected object payload.");
    }
    return parsed as GithubWebhookPayload;
  } catch {
    throw cliApiError(400, "PAYLOAD_INVALID", "GitHub webhook body must be valid JSON.");
  }
}

export async function processGithubWebhook(input: {
  deliveryId: string;
  eventName: string;
  payload: GithubWebhookPayload;
  requestId: string;
}) {
  const installationId = githubId(input.payload.installation);
  const repository = githubRecord(input.payload.repository);
  const repositoryId = repository ? githubId(repository) : null;
  const repositoryFullName = stringField(repository, "full_name")?.toLowerCase() ?? null;
  const providerResourceId = repositoryId ?? repositoryFullName;
  const safeEnvelope = githubSafeEnvelope({
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    installationId,
    payload: input.payload,
    repositoryFullName,
    repositoryId,
    requestId: input.requestId,
  });

  const [delivery] = await db
    .insert(schema.providerWebhookDeliveries)
    .values({
      provider: "github",
      providerDeliveryId: input.deliveryId,
      providerInstallationId: installationId ?? "unknown",
      providerResourceId,
      providerEventType: input.eventName,
      requestId: input.requestId,
      safeEnvelopeJson: safeEnvelope,
      status: "received",
    })
    .onConflictDoNothing()
    .returning();

  if (!delivery) {
    return {
      deliveryId: input.deliveryId,
      duplicate: true,
      inboxItemIds: [],
      matchedWatchIds: [],
      normalizedEventType: null,
      status: "ignored",
    } satisfies GithubWebhookProcessResult;
  }

  try {
    if (isGithubInstallationLifecycleEvent(input.eventName)) {
      if (!installationId) {
        await markDeliveryIgnored(delivery.id, "INSTALLATION_MISSING");
        return ignoredResult(input.deliveryId, null);
      }
      const sync = await syncGithubAppInstallationWebhook({
        eventName: input.eventName,
        installationId,
        payload: input.payload,
        requestId: input.requestId,
      });

      if (sync.status === "unlinked") {
        await markDeliveryIgnored(delivery.id, "INSTALLATION_NOT_LINKED");
        return ignoredResult(input.deliveryId, `github.${input.eventName}`);
      }

      await db
        .update(schema.providerWebhookDeliveries)
        .set({
          matchedWatchIdsJson: [],
          organizationId: sync.organizationId,
          processedAt: new Date(),
          status: "matched",
          updatedAt: new Date(),
        })
        .where(eq(schema.providerWebhookDeliveries.id, delivery.id));

      return {
        deliveryId: input.deliveryId,
        duplicate: false,
        inboxItemIds: [],
        matchedWatchIds: [],
        normalizedEventType: `github.${input.eventName}`,
        status: "matched",
      } satisfies GithubWebhookProcessResult;
    }

    if (!installationId || !repositoryFullName || !providerResourceId) {
      await markDeliveryIgnored(delivery.id, "PROVIDER_RESOURCE_UNAVAILABLE");
      return ignoredResult(input.deliveryId, null);
    }

    const normalized = normalizeGithubWebhookEvent(input.eventName, input.payload);
    if (!normalized) {
      await markDeliveryIgnored(delivery.id, "WATCH_UNSUPPORTED_EVENT");
      return ignoredResult(input.deliveryId, null);
    }

    const watches = await findMatchingGithubWatches({
      eventType: normalized.eventType,
      installationId,
      repositoryFullName,
      repositoryId,
    });

    if (watches.length === 0) {
      await markDeliveryIgnored(delivery.id, "NO_MATCHING_WATCH");
      return ignoredResult(input.deliveryId, normalized.eventType);
    }

    const inboxItemIds: string[] = [];
    const matchedWatchIds: string[] = [];
    for (const watch of watches) {
      matchedWatchIds.push(watch.id);
      const item = await recordAgentInboxItem({
        organizationId: watch.organizationId,
        projectId: watch.projectId,
        sourceType: "github_webhook",
        sourceId: input.deliveryId,
        eventType: normalized.eventType,
        category: "source_control",
        severity: normalized.severity,
        sensitivity: "metadata",
        title: normalized.title,
        summary: normalized.summary,
        actorType: "system",
        actorId: githubActorId(input.payload),
        targetType: "github_repository",
        targetId: providerResourceId,
        dedupeKey: `watch:${watch.id}:github:${input.deliveryId}:${normalized.eventType}`,
        payloadJson: {
          payload: normalized.payload,
          source: {
            provider: "github",
            providerAction: stringField(input.payload, "action"),
            providerEventType: input.eventName,
            deliveryId: input.deliveryId,
            eventType: normalized.eventType,
            installationId,
            repositoryId,
            repositoryFullName,
            requestId: input.requestId,
          },
          watch: {
            id: watch.id,
            eventType: normalized.eventType,
            eventTypes: watch.eventTypesJson,
            placement: watch.placement,
            provider: watch.provider,
            resourceRef: watch.resourceRef,
          },
        },
        linksJson: githubLinks(normalized.githubUrl),
        occurredAt: normalized.occurredAt,
      });

      if (item) inboxItemIds.push(item.id);
      await db
        .update(schema.consoleWatches)
        .set({
          lastDeliveryAt: item ? new Date() : watch.lastDeliveryAt,
          lastErrorCode: null,
          lastEventAt: normalized.occurredAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.consoleWatches.id, watch.id));
    }

    await db
      .update(schema.providerWebhookDeliveries)
      .set({
        inboxItemIdsJson: inboxItemIds,
        matchedWatchIdsJson: matchedWatchIds,
        organizationId: watches[0]?.organizationId,
        processedAt: new Date(),
        status: "matched",
        updatedAt: new Date(),
      })
      .where(eq(schema.providerWebhookDeliveries.id, delivery.id));

    return {
      deliveryId: input.deliveryId,
      duplicate: false,
      inboxItemIds,
      matchedWatchIds,
      normalizedEventType: normalized.eventType,
      status: "matched",
    } satisfies GithubWebhookProcessResult;
  } catch (error) {
    await db
      .update(schema.providerWebhookDeliveries)
      .set({
        errorCode: error instanceof Error ? error.name : "WEBHOOK_PROCESSING_FAILED",
        processedAt: new Date(),
        status: "failed",
        updatedAt: new Date(),
      })
      .where(eq(schema.providerWebhookDeliveries.id, delivery.id));
    throw error;
  }
}

export function normalizeGithubWebhookEvent(
  eventName: string,
  payload: GithubWebhookPayload,
): GithubWebhookEvent | null {
  switch (eventName) {
    case "push":
      return normalizePushEvent(payload);
    case "pull_request":
      return normalizePullRequestEvent(payload);
    case "issues":
      return normalizeIssueEvent(payload);
    case "workflow_run":
      return normalizeWorkflowRunEvent(payload);
    case "ping":
      return null;
    default:
      return null;
  }
}

function normalizePushEvent(payload: GithubWebhookPayload): GithubWebhookEvent | null {
  const repository = githubRecord(payload.repository);
  const headCommit = githubRecord(payload.head_commit);
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const ref = stringField(payload, "ref");
  const after = stringField(payload, "after");
  if (!repository || !ref || !after) return null;

  const repositoryFullName = stringField(repository, "full_name");
  const defaultBranch = stringField(repository, "default_branch");
  const isBranch = ref.startsWith("refs/heads/");
  const isTag = ref.startsWith("refs/tags/");
  if (!isBranch && !isTag) return null;

  const branch = isBranch ? ref.slice("refs/heads/".length) : null;
  const tag = isTag ? ref.slice("refs/tags/".length) : null;
  const eventType = isTag
    ? "watch.github.push.tag"
    : branch && defaultBranch && branch === defaultBranch
      ? "watch.github.push.default_branch"
      : "watch.github.push.branch";
  const refLabel = tag ? `tag ${tag}` : `branch ${branch ?? ref}`;
  return {
    eventType,
    githubUrl: stringField(headCommit, "url") ?? (repositoryFullName ? `https://github.com/${repositoryFullName}/commit/${after}` : null),
    occurredAt: parseDate(stringField(headCommit, "timestamp")) ?? new Date(),
    payload: {
      after,
      before: stringField(payload, "before"),
      branch,
      commitCount: commits.length,
      defaultBranch,
      headCommitSha: after,
      pusherLogin: stringField(githubRecord(payload.pusher), "name"),
      ref,
      refType: tag ? "tag" : "branch",
      repositoryFullName,
      tag,
      truncated: commits.length >= 20,
    },
    severity: "info",
    summary: `Push to ${repositoryFullName ?? "GitHub repository"} ${refLabel}.`,
    title: tag ? "GitHub tag push" : "GitHub branch push",
  };
}

function normalizePullRequestEvent(payload: GithubWebhookPayload): GithubWebhookEvent | null {
  const action = stringField(payload, "action");
  const pullRequest = githubRecord(payload.pull_request);
  if (!action || !pullRequest) return null;

  let suffix: string | null = null;
  if (action === "closed" && boolField(pullRequest, "merged")) {
    suffix = "merged";
  } else if (["opened", "closed", "reopened"].includes(action)) {
    suffix = action;
  }
  if (!suffix) return null;

  const number = numberField(pullRequest, "number") ?? numberField(payload, "number");
  const base = githubRecord(pullRequest.base);
  const head = githubRecord(pullRequest.head);
  const author = githubRecord(pullRequest.user);
  const repository = githubRecord(payload.repository);
  const repositoryFullName = stringField(repository, "full_name");
  const htmlUrl = stringField(pullRequest, "html_url");

  return {
    eventType: `watch.github.pull_request.${suffix}`,
    githubUrl: htmlUrl,
    occurredAt: parseDate(stringField(pullRequest, "updated_at")) ?? new Date(),
    payload: {
      action,
      authorLogin: stringField(author, "login"),
      baseRef: stringField(base, "ref"),
      headRef: stringField(head, "ref"),
      headSha: stringField(head, "sha"),
      htmlUrl,
      merged: boolField(pullRequest, "merged") ?? false,
      number,
      repositoryFullName,
      state: stringField(pullRequest, "state"),
      title: stringField(pullRequest, "title"),
    },
    severity: "info",
    summary: `Pull request #${number ?? "?"} ${suffix} in ${repositoryFullName ?? "GitHub repository"}.`,
    title: `GitHub pull request ${suffix}`,
  };
}

function normalizeIssueEvent(payload: GithubWebhookPayload): GithubWebhookEvent | null {
  const action = stringField(payload, "action");
  if (!["opened", "closed"].includes(action ?? "")) return null;
  const issue = githubRecord(payload.issue);
  if (!issue) return null;

  const repository = githubRecord(payload.repository);
  const repositoryFullName = stringField(repository, "full_name");
  const number = numberField(issue, "number");
  const htmlUrl = stringField(issue, "html_url");

  return {
    eventType: `watch.github.issue.${action}`,
    githubUrl: htmlUrl,
    occurredAt: parseDate(stringField(issue, "updated_at")) ?? new Date(),
    payload: {
      action,
      authorLogin: stringField(githubRecord(issue.user), "login"),
      htmlUrl,
      number,
      repositoryFullName,
      state: stringField(issue, "state"),
      title: stringField(issue, "title"),
    },
    severity: "info",
    summary: `Issue #${number ?? "?"} ${action} in ${repositoryFullName ?? "GitHub repository"}.`,
    title: `GitHub issue ${action}`,
  };
}

function normalizeWorkflowRunEvent(payload: GithubWebhookPayload): GithubWebhookEvent | null {
  const action = stringField(payload, "action");
  if (action !== "completed") return null;
  const workflowRun = githubRecord(payload.workflow_run);
  if (!workflowRun) return null;

  const repository = githubRecord(payload.repository);
  const repositoryFullName = stringField(repository, "full_name");
  const conclusion = stringField(workflowRun, "conclusion");
  const htmlUrl = stringField(workflowRun, "html_url");

  return {
    eventType: "watch.github.workflow_run.completed",
    githubUrl: htmlUrl,
    occurredAt: parseDate(stringField(workflowRun, "updated_at")) ?? new Date(),
    payload: {
      action,
      branch: stringField(workflowRun, "head_branch"),
      conclusion,
      headSha: stringField(workflowRun, "head_sha"),
      htmlUrl,
      name: stringField(workflowRun, "name"),
      repositoryFullName,
      runId: numberField(workflowRun, "id"),
      status: stringField(workflowRun, "status"),
    },
    severity: conclusion === "success" ? "success" : conclusion ? "error" : "info",
    summary: `Workflow run ${conclusion ?? "completed"} in ${repositoryFullName ?? "GitHub repository"}.`,
    title: "GitHub workflow run completed",
  };
}

async function findMatchingGithubWatches(input: {
  eventType: string;
  installationId: string;
  repositoryFullName: string;
  repositoryId: string | null;
}) {
  const resourcePredicates = [
    eq(schema.consoleWatches.resourceRef, input.repositoryFullName),
    eq(schema.consoleWatches.providerResourceId, input.repositoryFullName),
  ];
  if (input.repositoryId) {
    resourcePredicates.push(eq(schema.consoleWatches.providerResourceId, input.repositoryId));
  }

  return db
    .select()
    .from(schema.consoleWatches)
    .where(
      and(
        eq(schema.consoleWatches.provider, "github"),
        eq(schema.consoleWatches.placement, "console"),
        eq(schema.consoleWatches.status, "active"),
        eq(schema.consoleWatches.providerInstallationId, input.installationId),
        // A watch stops once its organization unlinks the installation.
        inArray(
          schema.consoleWatches.providerConnectionId,
          db
            .select({ id: schema.providerConnections.id })
            .from(schema.providerConnections)
            .where(inArray(schema.providerConnections.status, ["active", "degraded", "suspended"])),
        ),
        or(...resourcePredicates),
        sql`${schema.consoleWatches.eventTypesJson} ? ${input.eventType}`,
      ),
    );
}

async function markDeliveryIgnored(deliveryId: string, errorCode: string) {
  await db
    .update(schema.providerWebhookDeliveries)
    .set({
      errorCode,
      processedAt: new Date(),
      status: "ignored",
      updatedAt: new Date(),
    })
    .where(eq(schema.providerWebhookDeliveries.id, deliveryId));
}

function ignoredResult(deliveryId: string, normalizedEventType: string | null): GithubWebhookProcessResult {
  return {
    deliveryId,
    duplicate: false,
    inboxItemIds: [],
    matchedWatchIds: [],
    normalizedEventType,
    status: "ignored",
  };
}

function githubLinks(githubUrl: string | null) {
  return (githubUrl
    ? [{ label: "GitHub", provider: "github", url: githubUrl }]
    : []) as unknown as JsonRecord;
}

function githubSafeEnvelope(input: {
  deliveryId: string;
  eventName: string;
  installationId: string | null;
  payload: GithubWebhookPayload;
  repositoryFullName: string | null;
  repositoryId: string | null;
  requestId: string;
}): JsonRecord {
  if (isGithubInstallationLifecycleEvent(input.eventName)) {
    return {
      action: stringField(input.payload, "action"),
      account: safeGithubAccount(githubRecord(githubRecord(input.payload.installation)?.account)),
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      installation: safeGithubInstallation(githubRecord(input.payload.installation)),
      installationId: input.installationId,
      repositories: safeGithubRepositories(input.eventName === "installation_repositories"
        ? input.payload.repositories_added
        : input.payload.repositories),
      repositoriesAdded: safeGithubRepositories(input.payload.repositories_added),
      repositoriesRemoved: safeGithubRepositories(input.payload.repositories_removed),
      requestId: input.requestId,
      sender: safeGithubAccount(githubRecord(input.payload.sender)),
    };
  }

  return {
    action: stringField(input.payload, "action"),
    deliveryId: input.deliveryId,
    eventName: input.eventName,
    installationId: input.installationId,
    repositoryFullName: input.repositoryFullName,
    repositoryId: input.repositoryId,
    requestId: input.requestId,
  };
}

function isGithubInstallationLifecycleEvent(eventName: string) {
  return eventName === "installation" || eventName === "installation_repositories";
}

function safeGithubInstallation(installation: GithubWebhookPayload | null): JsonRecord | null {
  if (!installation) return null;
  return {
    account: safeGithubAccount(githubRecord(installation.account)),
    htmlUrl: stringField(installation, "html_url"),
    id: githubId(installation),
    repositorySelection: stringField(installation, "repository_selection"),
    targetType: stringField(installation, "target_type"),
  };
}

function safeGithubAccount(account: GithubWebhookPayload | null): JsonRecord | null {
  if (!account) return null;
  return {
    htmlUrl: stringField(account, "html_url"),
    id: githubId(account),
    login: stringField(account, "login"),
    type: stringField(account, "type"),
  };
}

function safeGithubRepositories(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is GithubWebhookPayload => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((repository) => ({
      defaultBranch: stringField(repository, "default_branch"),
      fullName: stringField(repository, "full_name"),
      id: githubId(repository),
      name: stringField(repository, "name"),
      private: boolField(repository, "private"),
      visibility: stringField(repository, "visibility"),
    }));
}

function githubActorId(payload: GithubWebhookPayload) {
  const login = stringField(githubRecord(payload.sender), "login");
  return login ? `github:${login}` : "github";
}

function githubId(value: unknown) {
  const record = githubRecord(value);
  const id = record ? record.id : null;
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function githubRecord(value: unknown): GithubWebhookPayload | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as GithubWebhookPayload
    : null;
}

function stringField(record: GithubWebhookPayload | null, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value ? value : null;
}

function numberField(record: GithubWebhookPayload | null, key: string) {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolField(record: GithubWebhookPayload | null, key: string) {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

function parseDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

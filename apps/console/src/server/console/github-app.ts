import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, notLike } from "drizzle-orm";

import type {
  GithubAppConnection,
  GithubAppRepository,
  GithubAvailableInstallation,
  OrganizationGithubConfig,
  ProjectGithubAppConfig,
} from "@/features/console/types";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { ConsoleApiError } from "./api-error";
import { findAccessibleProjectRecord } from "./project-access";
import { isUuidRef } from "./ref";
import type { ConsoleWorkspace } from "./workspace";

/*
 * A GitHub App installation belongs to the Console organization, not to a
 * project: one GitHub account installs the app once, and any number of Console
 * organizations can link that installation. Linking is proven, never taken
 * from a URL: the person signs in with GitHub (the App's user authorization),
 * and GitHub's own list of installations they can reach decides what they may
 * link. Projects use every repository of their organization's installations.
 */

const GITHUB_APP_CAPABILITIES = [
  "source.repo.metadata.read",
  "source.pull_request.read",
  "source.issue.read",
  "source.workflow_run.read",
];

const GITHUB_APP_SCOPES = [
  "metadata:read",
  "contents:read",
  "pull_requests:read",
  "issues:read",
  "actions:read",
];

const GITHUB_WATCH_EVENTS = [
  "push.branch",
  "push.default_branch",
  "push.tag",
  "pull_request.opened",
  "pull_request.closed",
  "pull_request.merged",
  "pull_request.reopened",
  "issue.opened",
  "issue.closed",
  "workflow_run.completed",
];

const LINKED_STATUSES = ["active", "degraded", "suspended"] as const;
const GITHUB_STATE_TTL_MS = 15 * 60 * 1000;
const GITHUB_USER_SESSION_TTL_MS = 30 * 60 * 1000;
const GITHUB_API = "https://api.github.com";
const MAX_REPOSITORY_PAGES = 30;

/** The cookie that keeps the person's GitHub sign-in for a few minutes, sealed. */
export const GITHUB_USER_SESSION_COOKIE = "ravi_github_user";
export const GITHUB_USER_SESSION_MAX_AGE_SECONDS = GITHUB_USER_SESSION_TTL_MS / 1000;

export type GithubAppState = {
  exp: number;
  iat: number;
  /** Set after an install: the installation to link once GitHub says who the person is. */
  installationId?: string | null;
  nonce: string;
  organizationId: string;
  userId: string;
};

type GithubUserSession = {
  exp: number;
  token: string;
  userId: string;
};

type GithubInstallationSnapshot = {
  accountId: string | null;
  accountLogin: string | null;
  accountType: string | null;
  githubUrl: string | null;
  installationId: string;
  repositories: GithubAppRepository[];
  repositorySelection: string | null;
};

/**
 * Which repositories a link may follow. GitHub lets anyone who can read one
 * repository of an installation see it, and shows them only the repositories
 * they can read; so only a link made by the installation's own account follows
 * repositories added later. Every other link keeps what its person could see.
 */
type GithubRepositoryAccess = "installation" | "linked_user";

type ProviderConnectionRecord = typeof schema.providerConnections.$inferSelect;

// --- Reads ------------------------------------------------------------------

export async function getOrganizationGithubConfig(input: {
  userSession: string | null | undefined;
  workspace: ConsoleWorkspace;
}): Promise<OrganizationGithubConfig> {
  const connections = await listOrganizationGithubConnections(input.workspace.organization.id);
  const session = openGithubUserSession(input.userSession, input.workspace.user.id);
  let available: GithubAvailableInstallation[] | null = null;
  let githubLogin: string | null = null;
  if (session) {
    try {
      const [user, installations] = await Promise.all([
        githubFetch<{ login?: string }>(session.token, "/user"),
        listGithubUserInstallations(session.token),
      ]);
      githubLogin = stringValue(user.login);
      const linked = new Set(connections.map((connection) => githubConnectionResponse(connection).installationId));
      available = installations.map((installation) => ({
        ...installation,
        linked: linked.has(installation.installationId),
      }));
    } catch (error) {
      // An expired or revoked sign-in reads as "sign in again", not as a failure.
      if (!(error instanceof GithubApiError) || error.status !== 401) throw error;
    }
  }

  return {
    available,
    canManage: canManageGithub(input.workspace),
    configured: {
      install: Boolean(githubAppExternalInstallUrl()),
      signIn: Boolean(githubAppClientId() && githubAppClientSecret() && githubAppStateSecret()),
    },
    callbackUrl: githubCallbackUrl(),
    connectUrl: "/api/console/github/connect",
    connections: connections.map(githubConnectionResponse),
    githubLogin,
    installUrl: "/api/console/github/install",
    setupUrl: githubSetupUrl(),
    supportedEventTypes: GITHUB_WATCH_EVENTS,
    webhookUrl: githubWebhookUrl(),
  };
}

export async function getProjectGithubAppConfig(input: {
  projectRef: string;
  workspace: ConsoleWorkspace;
}): Promise<ProjectGithubAppConfig | null> {
  const project = await findAccessibleProjectRecord(input.workspace, input.projectRef, "read");
  if (!project) return null;

  const connections = await listOrganizationGithubConnections(input.workspace.organization.id);
  return {
    connections: connections.map(githubConnectionResponse),
    manageUrl: "/org/github",
    projectId: project.id,
    projectName: project.name,
    projectSlug: project.slug,
    supportedEventTypes: GITHUB_WATCH_EVENTS,
  };
}

/**
 * The organization's linked installations, one row per installation. Rows from
 * before installations moved to the organization still carry a project; they
 * count for the whole organization, and a row linked at the organization wins.
 */
export async function listOrganizationGithubConnections(organizationId: string) {
  const rows = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.organizationId, organizationId),
        eq(schema.providerConnections.provider, "github"),
        inArray(schema.providerConnections.scopeKind, ["organization", "project"]),
        inArray(schema.providerConnections.status, [...LINKED_STATUSES]),
        // Installs started by the old per-project flow that never finished.
        notLike(schema.providerConnections.externalAccountId, "pending:%"),
      ),
    )
    .orderBy(desc(schema.providerConnections.updatedAt));

  const byInstallation = new Map<string, ProviderConnectionRecord>();
  for (const row of rows) {
    const key = row.externalAccountId ?? row.id;
    const current = byInstallation.get(key);
    if (!current || (current.scopeKind !== "organization" && row.scopeKind === "organization")) byInstallation.set(key, row);
  }
  return [...byInstallation.values()];
}

// --- Install and sign-in ----------------------------------------------------

/** Where "Install on another GitHub account" goes: GitHub's install page, carrying a signed state. */
export function startGithubAppInstall(workspace: ConsoleWorkspace) {
  requireManageGithub(workspace);
  const installUrl = githubAppExternalInstallUrl();
  if (!installUrl) throw new ConsoleApiError(409, { error: "github_app_not_configured" });

  const url = new URL(installUrl);
  url.searchParams.set("state", signGithubAppState(newGithubAppState(workspace, null)));
  return url.toString();
}

/** Where "Continue with GitHub" goes: GitHub's sign-in for the Ravi app. */
export function startGithubUserAuthorization(workspace: ConsoleWorkspace, installationId: string | null = null) {
  requireManageGithub(workspace);
  const clientId = githubAppClientId();
  if (!clientId || !githubAppClientSecret()) {
    throw new ConsoleApiError(409, { error: "github_sign_in_not_configured" });
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", githubCallbackUrl());
  url.searchParams.set("state", signGithubAppState(newGithubAppState(workspace, installationId)));
  return url.toString();
}

/**
 * GitHub sent the person back from its sign-in. Trades the code for their
 * token, and links the installation they just installed, when there is one and
 * GitHub confirms they can reach it. Returns the sealed sign-in for the cookie.
 */
export async function completeGithubUserAuthorization(input: {
  code: string | null;
  requestId: string;
  state: GithubAppState;
  workspace: ConsoleWorkspace;
}) {
  assertStateMatchesWorkspace(input.state, input.workspace);
  const code = input.code?.trim();
  if (!code) throw new ConsoleApiError(400, { error: "github_code_missing" });

  const token = await exchangeGithubCode(code);
  let linkedInstallationId: string | null = null;
  if (input.state.installationId) {
    await linkGithubInstallationWithToken({
      installationId: input.state.installationId,
      requestId: input.requestId,
      token,
      workspace: input.workspace,
    });
    linkedInstallationId = input.state.installationId;
  }

  return {
    linkedInstallationId,
    session: sealGithubUserSession({ exp: Date.now() + GITHUB_USER_SESSION_TTL_MS, token, userId: input.workspace.user.id }),
  };
}

export function readGithubAppState(state: string | null): GithubAppState | null {
  if (!state) return null;
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;
  const secret = githubAppStateSecret();
  if (!secret) return null;

  const expected = Buffer.from(hmac(encoded, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as GithubAppState;
    if (!parsed.organizationId || !parsed.userId || !parsed.exp) return null;
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function assertStateMatchesWorkspace(state: GithubAppState, workspace: ConsoleWorkspace) {
  if (workspace.organization.id !== state.organizationId || workspace.user.id !== state.userId) {
    throw new ConsoleApiError(403, { error: "github_state_mismatch" });
  }
}

// --- Link and unlink --------------------------------------------------------

export async function linkGithubInstallation(input: {
  body: unknown;
  requestId: string;
  userSession: string | null | undefined;
  workspace: ConsoleWorkspace;
}): Promise<OrganizationGithubConfig> {
  const installationId = idValue(recordValue(input.body)?.installationId);
  if (!installationId) throw new ConsoleApiError(400, { error: "github_installation_missing" });
  const session = openGithubUserSession(input.userSession, input.workspace.user.id);
  if (!session) throw new ConsoleApiError(401, { error: "github_sign_in_required" });

  await linkGithubInstallationWithToken({
    installationId,
    requestId: input.requestId,
    token: session.token,
    workspace: input.workspace,
  });
  return getOrganizationGithubConfig({ userSession: input.userSession, workspace: input.workspace });
}

export async function unlinkGithubInstallation(input: {
  connectionId: string;
  requestId: string;
  userSession: string | null | undefined;
  workspace: ConsoleWorkspace;
}): Promise<OrganizationGithubConfig> {
  requireManageGithub(input.workspace);
  const connection = isUuidRef(input.connectionId)
    ? (await listOrganizationGithubConnections(input.workspace.organization.id)).find((row) => row.id === input.connectionId)
    : undefined;
  if (!connection?.externalAccountId) throw new ConsoleApiError(404, { error: "github_installation_not_found" });

  // Every row of this installation in the organization, older per-project ones included.
  await db
    .update(schema.providerConnections)
    .set({ revokedAt: new Date(), status: "revoked_by_user", updatedAt: new Date() })
    .where(
      and(
        eq(schema.providerConnections.organizationId, input.workspace.organization.id),
        eq(schema.providerConnections.provider, "github"),
        eq(schema.providerConnections.externalAccountId, connection.externalAccountId),
        inArray(schema.providerConnections.status, [...LINKED_STATUSES]),
      ),
    );

  await db.insert(schema.auditEvents).values({
    organizationId: input.workspace.organization.id,
    actorType: "user",
    actorId: input.workspace.user.id,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "github_app.unlinked",
    requestId: input.requestId,
    metadataJson: {
      accountLogin: connection.externalAccountLogin,
      installationId: connection.externalAccountId,
      provider: "github",
    },
  });
  return getOrganizationGithubConfig({ userSession: input.userSession, workspace: input.workspace });
}

async function linkGithubInstallationWithToken(input: {
  installationId: string;
  requestId: string;
  token: string;
  workspace: ConsoleWorkspace;
}) {
  requireManageGithub(input.workspace);
  // GitHub only lists installations this person can reach: that is the proof.
  const [githubUser, installations] = await Promise.all([
    githubFetch<{ id?: unknown }>(input.token, "/user"),
    listGithubUserInstallations(input.token),
  ]);
  const installation = installations.find((candidate) => candidate.installationId === input.installationId);
  if (!installation) throw new ConsoleApiError(403, { error: "github_installation_not_accessible" });

  // Only the repositories this person can read on GitHub.
  const repositories = await listGithubInstallationRepositories(input.token, input.installationId);
  const githubUserId = idValue(githubUser.id);
  const repositoryAccess: GithubRepositoryAccess =
    installation.accountType === "User" && githubUserId !== null && installation.accountId === githubUserId
      ? "installation"
      : "linked_user";
  const connection = await upsertOrganizationGithubConnection({
    githubUserId,
    repositoryAccess,
    snapshot: {
      accountId: installation.accountId,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
      githubUrl: installation.githubUrl,
      installationId: input.installationId,
      repositories,
      repositorySelection: installation.repositorySelection,
    },
    suspended: installation.suspended,
    workspace: input.workspace,
  });

  await db.insert(schema.auditEvents).values({
    organizationId: input.workspace.organization.id,
    actorType: "user",
    actorId: input.workspace.user.id,
    targetType: "provider_connection",
    targetId: connection.id,
    action: "github_app.linked",
    requestId: input.requestId,
    metadataJson: {
      accountLogin: installation.accountLogin,
      installationId: input.installationId,
      provider: "github",
      repositoryAccess,
      repositoryCount: repositories.length,
    },
  });
  return connection;
}

async function upsertOrganizationGithubConnection(input: {
  githubUserId: string | null;
  repositoryAccess: GithubRepositoryAccess;
  snapshot: GithubInstallationSnapshot;
  suspended: boolean;
  workspace: ConsoleWorkspace;
}) {
  const { snapshot } = input;
  const accountLogin = snapshot.accountLogin ?? `installation-${snapshot.installationId}`;
  const values = {
    capabilitiesJson: GITHUB_APP_CAPABILITIES,
    displayName: `GitHub App: ${accountLogin}`,
    externalAccountLogin: accountLogin,
    grantedByUserId: input.workspace.user.id,
    lastVerifiedAt: new Date(),
    metadataJson: {
      accountId: snapshot.accountId,
      accountLogin,
      accountType: snapshot.accountType,
      githubUrl: snapshot.githubUrl,
      installationId: snapshot.installationId,
      linkedGithubUserId: input.githubUserId,
      providerInstallationId: snapshot.installationId,
      repositories: snapshot.repositories,
      repositoryAccess: input.repositoryAccess,
      repositorySelection: snapshot.repositorySelection,
      selectedRepositories: snapshot.repositories,
      source: "github-user-authorization",
      webhookUrl: githubWebhookUrl(),
    } satisfies JsonRecord,
    requiresReauth: false,
    revokedAt: null,
    scopesJson: GITHUB_APP_SCOPES,
    status: input.suspended ? "suspended" as const : snapshot.repositories.length ? "active" as const : "degraded" as const,
    updatedAt: new Date(),
  };

  // A link removed earlier comes back as the same row, so its watches come back too.
  const [existing] = await db
    .select({ id: schema.providerConnections.id })
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.organizationId, input.workspace.organization.id),
        eq(schema.providerConnections.provider, "github"),
        eq(schema.providerConnections.scopeKind, "organization"),
        eq(schema.providerConnections.externalAccountId, snapshot.installationId),
      ),
    )
    .orderBy(desc(schema.providerConnections.updatedAt))
    .limit(1);

  if (existing) {
    const [connection] = await db
      .update(schema.providerConnections)
      .set(values)
      .where(eq(schema.providerConnections.id, existing.id))
      .returning();
    if (!connection) throw new Error("Failed to update GitHub provider connection.");
    return connection;
  }

  const [connection] = await db
    .insert(schema.providerConnections)
    .values({
      ...values,
      organizationId: input.workspace.organization.id,
      projectId: null,
      userId: input.workspace.user.id,
      provider: "github",
      scopeKind: "organization",
      externalAccountId: snapshot.installationId,
      grantedAt: new Date(),
    })
    .returning();
  if (!connection) throw new Error("Failed to insert GitHub provider connection.");
  return connection;
}

// --- Webhooks ---------------------------------------------------------------

/**
 * Keeps every organization that linked an installation in step with GitHub.
 * An installation nobody linked yet is left alone: linking reads GitHub itself.
 */
export async function syncGithubAppInstallationWebhook(input: {
  eventName: string;
  installationId: string;
  payload: Record<string, unknown>;
  requestId: string;
}) {
  const action = stringValue(input.payload.action);
  const snapshot = githubInstallationSnapshotFromPayload(input.installationId, input.eventName, input.payload);
  const connections = await db
    .select()
    .from(schema.providerConnections)
    .where(
      and(
        eq(schema.providerConnections.provider, "github"),
        eq(schema.providerConnections.externalAccountId, input.installationId),
        inArray(schema.providerConnections.status, [...LINKED_STATUSES]),
      ),
    );

  if (connections.length === 0) {
    return { matchedConnectionIds: [], organizationId: null, status: "unlinked" as const };
  }

  if (action === "deleted") {
    for (const connection of connections) {
      await db
        .update(schema.providerConnections)
        .set({
          lastVerifiedAt: new Date(),
          metadataJson: {
            ...connection.metadataJson,
            deletedAt: new Date().toISOString(),
            lastWebhookAction: action,
            source: "github-app-installation-webhook",
          },
          requiresReauth: true,
          revokedAt: new Date(),
          status: "revoked_by_provider",
          updatedAt: new Date(),
        })
        .where(eq(schema.providerConnections.id, connection.id));
    }
    return {
      matchedConnectionIds: connections.map((connection) => connection.id),
      organizationId: connections[0]?.organizationId ?? null,
      status: "revoked" as const,
    };
  }

  for (const connection of connections) {
    const repositories = mergeGithubRepositoriesForWebhook({
      // Rows from the per-project flow were linked by whoever installed the app.
      access: connection.metadataJson.repositoryAccess === "linked_user" ? "linked_user" : "installation",
      eventName: input.eventName,
      existingRepositories: repositoriesFromMetadata(connection.metadataJson),
      payload: input.payload,
      snapshotRepositories: snapshot.repositories,
    });
    const suspended = action === "suspend" || (action !== "unsuspend" && connection.status === "suspended");
    await db
      .update(schema.providerConnections)
      .set({
        capabilitiesJson: GITHUB_APP_CAPABILITIES,
        displayName: snapshot.accountLogin ? `GitHub App: ${snapshot.accountLogin}` : connection.displayName,
        externalAccountLogin: snapshot.accountLogin ?? connection.externalAccountLogin,
        lastVerifiedAt: new Date(),
        metadataJson: {
          ...connection.metadataJson,
          accountId: snapshot.accountId ?? connection.metadataJson.accountId ?? null,
          accountLogin: snapshot.accountLogin ?? connection.externalAccountLogin,
          accountType: snapshot.accountType ?? connection.metadataJson.accountType ?? null,
          githubUrl: snapshot.githubUrl ?? connection.metadataJson.githubUrl ?? null,
          installationId: input.installationId,
          lastWebhookAction: action,
          providerInstallationId: input.installationId,
          repositories,
          repositorySelection: snapshot.repositorySelection ?? connection.metadataJson.repositorySelection ?? null,
          selectedRepositories: repositories,
          source: "github-app-installation-webhook",
          webhookUrl: githubWebhookUrl(),
        },
        requiresReauth: false,
        revokedAt: null,
        scopesJson: GITHUB_APP_SCOPES,
        status: suspended ? "suspended" : repositories.length > 0 ? "active" : "degraded",
        updatedAt: new Date(),
      })
      .where(eq(schema.providerConnections.id, connection.id));
  }

  return {
    matchedConnectionIds: connections.map((connection) => connection.id),
    organizationId: connections[0]?.organizationId ?? null,
    status: "synced" as const,
  };
}

export function githubInstallationSnapshotFromEnvelope(
  installationId: string,
  envelope: JsonRecord,
): GithubInstallationSnapshot | null {
  const installation = recordValue(envelope.installation);
  const account = recordValue(installation?.account ?? envelope.account);
  const repositories = arrayValue(envelope.repositories)
    .filter(isRecord)
    .map((item) => normalizeRepository({
      defaultBranch: stringValue(item.defaultBranch) ?? stringValue(item.default_branch),
      fullName: stringValue(item.fullName) ?? stringValue(item.full_name) ?? "",
      id: stringValue(item.id) ?? stringValue(item.nodeId) ?? "",
      name: stringValue(item.name),
      selected: item.selected !== false,
      visibility: stringValue(item.visibility),
    }))
    .filter((repository) => repository.id && repository.fullName);

  if (!account && repositories.length === 0) return null;
  return {
    accountId: idValue(account?.id),
    accountLogin: stringValue(account?.login),
    accountType: stringValue(account?.type),
    githubUrl: stringValue(installation?.htmlUrl) ?? stringValue(installation?.html_url),
    installationId,
    repositories,
    repositorySelection: stringValue(installation?.repositorySelection) ?? stringValue(installation?.repository_selection),
  };
}

function githubInstallationSnapshotFromPayload(
  installationId: string,
  eventName: string,
  payload: Record<string, unknown>,
): GithubInstallationSnapshot {
  const installation = recordValue(payload.installation);
  const account = recordValue(installation?.account);
  return {
    accountId: idValue(account?.id),
    accountLogin: stringValue(account?.login),
    accountType: stringValue(account?.type),
    githubUrl: stringValue(installation?.html_url) ?? stringValue(installation?.htmlUrl),
    installationId,
    repositories: eventName === "installation_repositories"
      ? githubRepositoriesFromArray(payload.repositories_added)
      : githubRepositoriesFromArray(payload.repositories),
    repositorySelection: stringValue(installation?.repository_selection) ?? stringValue(installation?.repositorySelection),
  };
}

function mergeGithubRepositoriesForWebhook(input: {
  access: GithubRepositoryAccess;
  eventName: string;
  existingRepositories: GithubAppRepository[];
  payload: Record<string, unknown>;
  snapshotRepositories: GithubAppRepository[];
}) {
  if (input.eventName === "installation_repositories") {
    const removed = new Set(githubRepositoriesFromArray(input.payload.repositories_removed).map((repo) => repo.id));
    const merged = new Map(input.existingRepositories.filter((repo) => !removed.has(repo.id)).map((repo) => [repo.id, repo]));
    if (input.access === "installation") {
      for (const repo of githubRepositoriesFromArray(input.payload.repositories_added)) merged.set(repo.id, repo);
    }
    return [...merged.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }
  // `installation` events without a repository list (suspend, new_permissions_accepted) keep what we had.
  if (!Array.isArray(input.payload.repositories)) return input.existingRepositories;
  if (input.access === "installation") return input.snapshotRepositories;
  const present = new Set(input.snapshotRepositories.map((repo) => repo.id));
  return input.existingRepositories.filter((repo) => present.has(repo.id));
}

// --- GitHub API -------------------------------------------------------------

export class GithubApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function githubFetch<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ravi-console",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new GithubApiError(response.status, `GitHub ${path} answered ${response.status}`);
  return response.json() as Promise<T>;
}

/** The installations of the Ravi app that this person can reach on GitHub. */
async function listGithubUserInstallations(token: string): Promise<Omit<GithubAvailableInstallation, "linked">[]> {
  const installations: Omit<GithubAvailableInstallation, "linked">[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await githubFetch<{ installations?: unknown[] }>(token, `/user/installations?per_page=100&page=${page}`);
    const items = arrayValue(body.installations).filter(isRecord);
    for (const item of items) {
      const installationId = idValue(item.id);
      if (!installationId) continue;
      const account = recordValue(item.account);
      installations.push({
        accountId: idValue(account?.id),
        accountLogin: stringValue(account?.login) ?? `installation-${installationId}`,
        accountType: stringValue(account?.type),
        avatarUrl: stringValue(account?.avatar_url),
        githubUrl: stringValue(item.html_url),
        installationId,
        repositorySelection: stringValue(item.repository_selection),
        suspended: Boolean(item.suspended_at),
      });
    }
    if (items.length < 100) break;
  }
  return installations;
}

async function listGithubInstallationRepositories(token: string, installationId: string) {
  const repositories: GithubAppRepository[] = [];
  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
    const body = await githubFetch<{ repositories?: unknown[] }>(
      token,
      `/user/installations/${encodeURIComponent(installationId)}/repositories?per_page=100&page=${page}`,
    );
    const items = arrayValue(body.repositories);
    repositories.push(...githubRepositoriesFromArray(items));
    if (items.length < 100) break;
  }
  return repositories.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

async function exchangeGithubCode(code: string) {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: JSON.stringify({
      client_id: githubAppClientId(),
      client_secret: githubAppClientSecret(),
      code,
      redirect_uri: githubCallbackUrl(),
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "ravi-console" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; error?: unknown } | null;
  const token = stringValue(body?.access_token);
  if (!response.ok || !token) {
    throw new ConsoleApiError(400, { error: "github_sign_in_failed", reason: stringValue(body?.error) ?? undefined });
  }
  return token;
}

// --- Responses and repositories --------------------------------------------

function githubConnectionResponse(connection: ProviderConnectionRecord): GithubAppConnection {
  const metadata = connection.metadataJson;
  return {
    id: connection.id,
    accountId: stringValue(metadata.accountId),
    accountLogin: connection.externalAccountLogin ?? null,
    accountType: stringValue(metadata.accountType),
    capabilities: connection.capabilitiesJson,
    displayName: connection.displayName,
    grantedAt: connection.grantedAt.toISOString(),
    githubUrl: stringValue(metadata.githubUrl),
    installationId: stringValue(metadata.installationId) ?? connection.externalAccountId ?? "",
    repositories: repositoriesFromMetadata(metadata),
    repositorySelection: stringValue(metadata.repositorySelection),
    requiresReauth: connection.requiresReauth,
    status: connection.status,
    updatedAt: connection.updatedAt.toISOString(),
  };
}

function repositoriesFromMetadata(metadata: JsonRecord): GithubAppRepository[] {
  const raw = metadata.selectedRepositories ?? metadata.repositories ?? [];
  return arrayValue(raw)
    .filter(isRecord)
    .map((item) => normalizeRepository({
      defaultBranch: stringValue(item.defaultBranch) ?? stringValue(item.default_branch),
      fullName: stringValue(item.fullName) ?? stringValue(item.full_name) ?? "",
      id: stringValue(item.id) ?? stringValue(item.nodeId) ?? "",
      name: stringValue(item.name),
      selected: item.selected !== false,
      visibility: stringValue(item.visibility),
    }))
    .filter((repository) => repository.id && repository.fullName);
}

function githubRepositoriesFromArray(value: unknown): GithubAppRepository[] {
  return arrayValue(value)
    .filter(isRecord)
    .map((item) => normalizeRepository({
      defaultBranch: stringValue(item.default_branch) ?? stringValue(item.defaultBranch),
      fullName: stringValue(item.full_name) ?? stringValue(item.fullName) ?? "",
      id: idValue(item.id) ?? idValue(item.node_id) ?? "",
      name: stringValue(item.name),
      selected: true,
      visibility: stringValue(item.visibility) ?? (item.private === true ? "private" : null),
    }))
    .filter((repository) => repository.id && repository.fullName)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}

function normalizeRepository(input: {
  defaultBranch: string | null;
  fullName: string;
  id: string;
  name: string | null;
  selected: boolean;
  visibility: string | null;
}): GithubAppRepository {
  const fullName = input.fullName.trim();
  return {
    defaultBranch: input.defaultBranch?.trim() || null,
    fullName,
    id: input.id.trim(),
    name: input.name?.trim() || fullName.split("/").at(1) || fullName,
    selected: input.selected,
    visibility: input.visibility?.trim() || null,
  };
}

// --- State, sealed sign-in, configuration ----------------------------------

function canManageGithub(workspace: ConsoleWorkspace) {
  // Organization integration administration is not project data authorization.
  // Project bindings still pass findAccessibleProjectRecord independently.
  return workspace.mode !== "anonymous" && ["owner", "admin"].includes(workspace.membership.role);
}

function requireManageGithub(workspace: ConsoleWorkspace) {
  if (!canManageGithub(workspace)) throw new ConsoleApiError(403, { error: "github_manage_forbidden" });
}

function newGithubAppState(workspace: ConsoleWorkspace, installationId: string | null): GithubAppState {
  return {
    exp: Date.now() + GITHUB_STATE_TTL_MS,
    iat: Date.now(),
    installationId,
    nonce: randomUUID(),
    organizationId: workspace.organization.id,
    userId: workspace.user.id,
  };
}

function signGithubAppState(state: GithubAppState) {
  const secret = githubAppStateSecret();
  if (!secret) throw new ConsoleApiError(503, { error: "github_app_state_secret_missing" });
  const encoded = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded, secret)}`;
}

/** Seals the GitHub sign-in (AES-256-GCM) so the cookie neither leaks nor moves to another person. */
export function sealGithubUserSession(session: GithubUserSession) {
  const key = githubUserSessionKey();
  if (!key) throw new ConsoleApiError(503, { error: "github_app_state_secret_missing" });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), sealed].map((part) => part.toString("base64url")).join(".");
}

export function openGithubUserSession(value: string | null | undefined, userId: string): GithubUserSession | null {
  const key = githubUserSessionKey();
  if (!value || !key) return null;
  const [iv, tag, sealed] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !sealed || iv.length !== 12 || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const session = JSON.parse(Buffer.concat([decipher.update(sealed), decipher.final()]).toString("utf8")) as GithubUserSession;
    if (session.userId !== userId || !session.token || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function githubUserSessionKey() {
  const secret = githubAppStateSecret();
  return secret ? createHash("sha256").update(`ravi-github-user-session:${secret}`).digest() : null;
}

function consoleBaseUrl() {
  return process.env.NEXT_PUBLIC_CONSOLE_URL?.trim().replace(/\/$/, "") || "https://console.ravi.bot";
}

function githubWebhookUrl() {
  return `${consoleBaseUrl()}/api/internal/watches/github/webhook`;
}

function githubSetupUrl() {
  return `${consoleBaseUrl()}/github/setup`;
}

function githubCallbackUrl() {
  return `${consoleBaseUrl()}/github/callback`;
}

function githubAppExternalInstallUrl() {
  const explicit = process.env.RAVI_GITHUB_APP_INSTALL_URL?.trim();
  if (explicit) return explicit;
  const slug = process.env.RAVI_GITHUB_APP_SLUG?.trim();
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

function githubAppClientId() {
  return process.env.RAVI_GITHUB_APP_CLIENT_ID?.trim() || null;
}

function githubAppClientSecret() {
  return process.env.RAVI_GITHUB_APP_CLIENT_SECRET?.trim() || null;
}

function githubAppStateSecret() {
  return process.env.RAVI_GITHUB_APP_STATE_SECRET?.trim()
    || process.env.RAVI_CLI_ACCESS_TOKEN_SECRET?.trim()
    || process.env.WORKOS_COOKIE_PASSWORD?.trim()
    || process.env.RAVI_GITHUB_WEBHOOK_SECRET?.trim()
    || null;
}

function hmac(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function idValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

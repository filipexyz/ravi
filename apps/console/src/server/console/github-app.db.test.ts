import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { ConsoleApiError } from "./api-error";
import {
  getOrganizationGithubConfig,
  getProjectGithubAppConfig,
  linkGithubInstallation,
  sealGithubUserSession,
  syncGithubAppInstallationWebhook,
  unlinkGithubInstallation,
} from "./github-app";
import { processGithubWebhook } from "./github-webhook";
import type { ConsoleWorkspace } from "./workspace";

// Runs only with ACCESS_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database; creates and deletes its own fixtures.
const url = process.env.ACCESS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

process.env.RAVI_GITHUB_APP_STATE_SECRET ||= "github-app-db-test-secret";

const suffix = randomUUID().slice(0, 8);
const orgA = randomUUID();
const orgB = randomUUID();
const projectA = randomUUID();
const dev = randomUUID();
const viewer = randomUUID();
const legacyConnection = randomUUID();
const pendingConnection = randomUUID();
// Installation ids are GitHub's: numbers, unique per test run.
const base = 900_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
const acme = String(base + 1);
const solo = String(base + 2);
const stranger = String(base + 3);
const legacy = String(base + 4);

function workspace(organizationId: string, userId: string, role: string) {
  return {
    membership: { role, status: "active" },
    mode: "workos",
    organization: { id: organizationId, name: "Org", slug: `org-${suffix}` },
    user: { id: userId },
  } as unknown as ConsoleWorkspace;
}

const session = (userId: string) => sealGithubUserSession({ exp: Date.now() + 60_000, token: `ghu_${userId}`, userId });

/** GitHub, as the signed-in person sees it: `acme` and `solo` are theirs, `stranger` is not. */
const realFetch = globalThis.fetch;
function fakeGithub() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/user") return Response.json({ id: 2, login: "luis" });
    if (path === "/user/installations") {
      return Response.json({
        installations: [
          { account: { id: 1, login: "acme", type: "Organization" }, html_url: "https://github.com/acme", id: Number(acme), repository_selection: "selected" },
          { account: { id: 2, login: "luis", type: "User" }, id: Number(solo), repository_selection: "all" },
        ],
      });
    }
    if (path === `/user/installations/${acme}/repositories`) {
      return Response.json({ repositories: [{ default_branch: "main", full_name: "acme/api", id: 11, name: "api", private: true }] });
    }
    if (path === `/user/installations/${solo}/repositories`) return Response.json({ repositories: [] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ConsoleApiError) return error.payload.error;
    throw error;
  }
}

async function githubRows(organizationId: string) {
  return db
    .select()
    .from(schema.providerConnections)
    .where(and(eq(schema.providerConnections.organizationId, organizationId), eq(schema.providerConnections.provider, "github")));
}

describeDb("GitHub installations belong to the organization", () => {
  beforeAll(async () => {
    await db.insert(schema.organizations).values([
      { id: orgA, name: "A", slug: `gh-a-${suffix}` },
      { id: orgB, name: "B", slug: `gh-b-${suffix}` },
    ]);
    await db.insert(schema.projects).values({ id: projectA, name: "Repo work", organizationId: orgA, slug: `repo-${suffix}` });
    await db.insert(schema.users).values([
      { id: dev, primaryEmail: `dev-${suffix}@example.test` },
      { id: viewer, primaryEmail: `viewer-${suffix}@example.test` },
    ]);
    await db.insert(schema.organizationMemberships).values([
      { organizationId: orgA, role: "developer", userId: dev },
      { organizationId: orgB, role: "admin", userId: dev },
      { organizationId: orgA, role: "viewer", userId: viewer },
    ]);
    // What the per-project flow left behind: one finished install, one never finished.
    await db.insert(schema.providerConnections).values([
      {
        id: legacyConnection,
        organizationId: orgA,
        projectId: projectA,
        provider: "github",
        scopeKind: "project",
        externalAccountId: legacy,
        externalAccountLogin: "old-org",
        displayName: "GitHub App: old-org",
        status: "active",
        metadataJson: { installationId: legacy, repositories: [{ fullName: "old-org/site", id: "44" }] },
      },
      {
        id: pendingConnection,
        organizationId: orgA,
        projectId: projectA,
        provider: "github",
        scopeKind: "project",
        externalAccountId: `pending:${projectA}`,
        displayName: "GitHub App install pending",
        status: "degraded",
        metadataJson: { pendingInstall: true },
      },
    ]);
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await db.delete(schema.consoleWatches).where(inArray(schema.consoleWatches.organizationId, [orgA, orgB]));
    await db.delete(schema.agentInboxItems).where(inArray(schema.agentInboxItems.organizationId, [orgA, orgB]));
    await db.delete(schema.providerWebhookDeliveries).where(inArray(schema.providerWebhookDeliveries.providerInstallationId, [acme, solo, stranger, legacy]));
    await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.organizationId, [orgA, orgB]));
    await db.delete(schema.providerConnections).where(inArray(schema.providerConnections.organizationId, [orgA, orgB]));
    await db.delete(schema.organizationMemberships).where(inArray(schema.organizationMemberships.organizationId, [orgA, orgB]));
    await db.delete(schema.projects).where(eq(schema.projects.id, projectA));
    await db.delete(schema.users).where(inArray(schema.users.id, [dev, viewer]));
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [orgA, orgB]));
  });

  test("a finished install from a project counts for the organization; an unfinished one does not", async () => {
    const config = await getOrganizationGithubConfig({ userSession: null, workspace: workspace(orgA, dev, "developer") });
    expect(config.available).toBeNull();
    expect(config.connections.map((connection) => connection.installationId)).toEqual([legacy]);

    const project = await getProjectGithubAppConfig({ projectRef: projectA, workspace: workspace(orgA, dev, "developer") });
    expect(project?.connections.map((connection) => connection.accountLogin)).toEqual(["old-org"]);
    expect(project?.manageUrl).toBe("/org/github");
  });

  test("signed in, GitHub's own list says what can be linked", async () => {
    fakeGithub();
    const config = await getOrganizationGithubConfig({ userSession: session(dev), workspace: workspace(orgA, dev, "developer") });
    expect(config.githubLogin).toBe("luis");
    expect(config.available?.map((installation) => [installation.accountLogin, installation.linked])).toEqual([
      ["acme", false],
      ["luis", false],
    ]);
  });

  test("links an installation GitHub lists, with its repositories", async () => {
    fakeGithub();
    const config = await linkGithubInstallation({
      body: { installationId: acme },
      requestId: `req-${suffix}`,
      userSession: session(dev),
      workspace: workspace(orgA, dev, "developer"),
    });
    const linked = config.connections.find((connection) => connection.installationId === acme);
    expect(linked).toMatchObject({ accountLogin: "acme", accountType: "Organization", status: "active" });
    expect(linked?.repositories.map((repository) => repository.fullName)).toEqual(["acme/api"]);
    expect(config.available?.find((installation) => installation.installationId === acme)?.linked).toBe(true);

    const [row] = (await githubRows(orgA)).filter((candidate) => candidate.externalAccountId === acme);
    expect(row).toMatchObject({ projectId: null, scopeKind: "organization" });
  });

  test("the same installation links to a second organization", async () => {
    fakeGithub();
    const config = await linkGithubInstallation({
      body: { installationId: acme },
      requestId: `req-${suffix}`,
      userSession: session(dev),
      workspace: workspace(orgB, dev, "admin"),
    });
    expect(config.connections.map((connection) => connection.installationId)).toEqual([acme]);
  });

  test("refuses an installation GitHub doesn't list, another person's sign-in, and a viewer", async () => {
    fakeGithub();
    expect(await errorCode(linkGithubInstallation({
      body: { installationId: stranger },
      requestId: `req-${suffix}`,
      userSession: session(dev),
      workspace: workspace(orgA, dev, "developer"),
    }))).toBe("github_installation_not_accessible");
    expect(await errorCode(linkGithubInstallation({
      body: { installationId: acme },
      requestId: `req-${suffix}`,
      userSession: session(dev),
      workspace: workspace(orgA, viewer, "viewer"),
    }))).toBe("github_sign_in_required");
    expect(await errorCode(linkGithubInstallation({
      body: { installationId: acme },
      requestId: `req-${suffix}`,
      userSession: session(viewer),
      workspace: workspace(orgA, viewer, "viewer"),
    }))).toBe("github_manage_forbidden");
    expect((await githubRows(orgA)).some((row) => row.externalAccountId === stranger)).toBe(false);
  });

  test("a webhook from an installation nobody linked binds to nothing", async () => {
    const result = await syncGithubAppInstallationWebhook({
      eventName: "installation",
      installationId: stranger,
      payload: { action: "created", installation: { account: { login: "someone" }, id: Number(stranger) }, repositories: [] },
      requestId: `req-${suffix}`,
    });
    expect(result.status).toBe("unlinked");
    expect((await githubRows(orgA)).some((row) => row.externalAccountId === stranger)).toBe(false);
  });

  test("repositories added on GitHub reach only links made by the installation's own account", async () => {
    fakeGithub();
    await linkGithubInstallation({
      body: { installationId: solo },
      requestId: `req-${suffix}`,
      userSession: session(dev),
      workspace: workspace(orgA, dev, "developer"),
    });
    const added = (installationId: string, repo: { full_name: string; id: number; name: string }) =>
      syncGithubAppInstallationWebhook({
        eventName: "installation_repositories",
        installationId,
        payload: {
          action: "added",
          installation: { id: Number(installationId) },
          repositories_added: [repo],
          repositories_removed: [],
        },
        requestId: `req-${suffix}`,
      });
    await added(solo, { full_name: "luis/notes", id: 21, name: "notes" });
    // The person who linked `acme` may not be able to read what its owners add.
    await added(acme, { full_name: "acme/secret", id: 12, name: "secret" });

    const repos = async (org: string, installationId: string) =>
      (await getOrganizationGithubConfig({ userSession: null, workspace: workspace(org, dev, "admin") })).connections
        .find((connection) => connection.installationId === installationId)
        ?.repositories.map((repository) => repository.fullName);
    expect(await repos(orgA, solo)).toEqual(["luis/notes"]);
    for (const org of [orgA, orgB]) expect(await repos(org, acme)).toEqual(["acme/api"]);
  });

  test("repositories removed on GitHub leave every organization that linked it", async () => {
    await syncGithubAppInstallationWebhook({
      eventName: "installation_repositories",
      installationId: solo,
      payload: {
        action: "removed",
        installation: { id: Number(solo) },
        repositories_added: [],
        repositories_removed: [{ full_name: "luis/notes", id: 21, name: "notes" }],
      },
      requestId: `req-${suffix}`,
    });
    const config = await getOrganizationGithubConfig({ userSession: null, workspace: workspace(orgA, dev, "admin") });
    expect(config.connections.find((connection) => connection.installationId === solo)?.repositories).toEqual([]);
  });

  test("unlinking stops the organization's watches but not another organization's", async () => {
    const rows = [...await githubRows(orgA), ...await githubRows(orgB)].filter((row) => row.externalAccountId === acme);
    await db.insert(schema.consoleWatches).values(rows.map((row) => ({
      organizationId: row.organizationId,
      projectId: row.organizationId === orgA ? projectA : null,
      provider: "github",
      placement: "console" as const,
      providerConnectionId: row.id,
      providerInstallationId: acme,
      providerResourceId: "11",
      resourceRef: "acme/api",
      watchKey: `watch:test:${row.id}`,
      eventTypesJson: ["watch.github.pull_request.opened"],
    })));

    const delivery = async () => processGithubWebhook({
      deliveryId: randomUUID(),
      eventName: "pull_request",
      payload: {
        action: "opened",
        installation: { id: Number(acme) },
        number: 7,
        pull_request: { html_url: "https://github.com/acme/api/pull/7", number: 7, title: "Add it", user: { login: "luis" } },
        repository: { full_name: "acme/api", id: 11 },
      },
      requestId: `req-${suffix}`,
    });

    expect((await delivery()).matchedWatchIds).toHaveLength(2);

    const linked = rows.find((row) => row.organizationId === orgA)!;
    const config = await unlinkGithubInstallation({
      connectionId: linked.id,
      requestId: `req-${suffix}`,
      userSession: null,
      workspace: workspace(orgA, dev, "developer"),
    });
    expect(config.connections.some((connection) => connection.installationId === acme)).toBe(false);

    const after = await delivery();
    expect(after.matchedWatchIds).toHaveLength(1);
  });

  test("unlinking a row from the per-project flow removes it for the organization", async () => {
    await unlinkGithubInstallation({
      connectionId: legacyConnection,
      requestId: `req-${suffix}`,
      userSession: null,
      workspace: workspace(orgA, dev, "developer"),
    });
    const config = await getOrganizationGithubConfig({ userSession: null, workspace: workspace(orgA, dev, "developer") });
    expect(config.connections.some((connection) => connection.installationId === legacy)).toBe(false);
  });
});

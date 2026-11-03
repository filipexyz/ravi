import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { inArray, sql } from "drizzle-orm";

import { db, schema } from "@/server/db";

import type { CloudContext, CloudDeps } from "./access";
import { routeCloudAgentsConsoleRequest } from "./console";
import { isCloudAgentsError } from "./errors";
import { FakeCloudProviderState, fakeCloudProviderFactory } from "./providers/fake";
import { setCloudCredential } from "./service";

// The Console UI's extra cloud agents routes against a migrated database and
// the fake provider: availability, deployable Library agents, HEARTBEAT.md,
// the monthly alert and manual runs. Runs only with
// CLOUD_AGENTS_TEST_DATABASE_URL (and DATABASE_URL) pointing at that database.
const url = process.env.CLOUD_AGENTS_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const project = { id: randomUUID(), slug: `cloud-ui-${suffix}` };
const users = {
  owner: { id: randomUUID(), role: "owner" },
  dev: { id: randomUUID(), role: "developer" },
  viewer: { id: randomUUID(), role: "viewer" },
} as const;
const FAKE_API_KEY = `sk-ant-fake-${"1".repeat(32)}`;

const state = new FakeCloudProviderState();
const env = { RAVI_CLOUD_AGENTS_KEY: randomBytes(32).toString("base64"), RAVI_MCP_BASE_URL: "https://mcp.test.invalid" } as unknown as NodeJS.ProcessEnv;
const cloudDeps: CloudDeps = {
  providerFactory: fakeCloudProviderFactory(state),
  env,
  mintRepositoryToken: async ({ repo }) => ({ url: `https://github.com/${repo}`, token: "fake-installation-token" }),
};

function ctx(user: keyof typeof users, deps: CloudDeps = cloudDeps): CloudContext {
  return {
    workspace: { user: { id: users[user].id }, organization: { id: orgId }, membership: { role: users[user].role } },
    requestId: `req-${randomUUID()}`,
    surface: "console",
    deps,
  };
}

async function call(user: keyof typeof users, method: string, path: string, body: unknown = {}, deps?: CloudDeps) {
  const [route, search = ""] = path.split("?");
  const result = await routeCloudAgentsConsoleRequest(ctx(user, deps), method, route!.split("/").filter(Boolean), body, new URLSearchParams(search));
  if (result.kind !== "json") throw new Error("expected json");
  return result.payload as Record<string, unknown>;
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isCloudAgentsError(error)) return error.code;
    throw error;
  }
  return "ok";
}

async function publishAgent(slug: string, files: Record<string, string>) {
  const itemId = randomUUID();
  const versionId = randomUUID();
  const entries = Object.entries(files);
  await db.insert(schema.libraryItems).values({ id: itemId, organizationId: orgId, projectId: project.id, kind: "agent", slug, name: slug, description: `${slug} agent` });
  await db.insert(schema.libraryVersions).values({
    id: versionId,
    itemId,
    organizationId: orgId,
    versionNumber: 1,
    status: "published",
    contentHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0),
    publishedAt: new Date(),
  });
  await db.insert(schema.libraryFiles).values(
    entries.map(([path, content]) => ({ versionId, path, content, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") })),
  );
  await db.execute(sql`UPDATE library_items SET current_version_id = ${versionId}::uuid, current_version_number = 1, published_at = now() WHERE id = ${itemId}::uuid`);
  return itemId;
}

describeDb("cloud agents console routes (db, fake provider)", () => {
  let reporterItem = "";

  beforeAll(async () => {
    const all = Object.entries(users);
    await db.insert(schema.users).values(all.map(([label, user]) => ({ id: user.id, primaryEmail: `cloud-ui-${suffix}-${label}@example.test`, displayName: label })));
    await db.insert(schema.organizations).values({ id: orgId, slug: `cloud-ui-${suffix}`, name: "Cloud UI test" });
    await db.insert(schema.organizationMemberships).values(all.map(([, user]) => ({ organizationId: orgId, userId: user.id, role: user.role })));
    await db.insert(schema.projects).values({ id: project.id, organizationId: orgId, slug: project.slug, name: "Cloud UI project" });
    // Viewers reach only the projects they are members of.
    await db.insert(schema.projectMemberships).values({ projectId: project.id, userId: users.viewer.id, role: "viewer" });
    reporterItem = await publishAgent("reporter", {
      "AGENTS.md": "# Reporter\n",
      "HEARTBEAT.md": "Check whether this week's report is due.\n",
      "agent.json": JSON.stringify({ model: "sonnet" }),
    });
    await publishAgent("quiet", { "AGENTS.md": "# Quiet\n" });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, Object.values(users).map((user) => user.id)));
  });

  test("availability names the state and what the role may do", async () => {
    expect(await call("viewer", "GET", "availability")).toEqual({
      availability: { state: "available", canWrite: false, canManageKey: false },
      viewerId: users.viewer.id,
    });
    expect((await call("dev", "GET", "availability")).availability).toEqual({ state: "available", canWrite: true, canManageKey: false });
    const unconfigured = await call("owner", "GET", "availability", {}, { ...cloudDeps, env: {} as NodeJS.ProcessEnv });
    expect(unconfigured.availability).toEqual({ state: "unconfigured", canWrite: true, canManageKey: true });
  });

  test("library agents list what can be deployed and what already is", async () => {
    const before = (await call("viewer", "GET", `library-agents?project=${project.slug}`)).agents as Array<Record<string, unknown>>;
    expect(before.map((agent) => agent.slug)).toEqual(["quiet", "reporter"]);
    expect(before.every((agent) => agent.deployed === null && agent.version === 1 && agent.scope === project.slug)).toBe(true);

    await setCloudCredential(ctx("owner"), { provider: "anthropic", apiKey: FAKE_API_KEY });
    const deployed = (await call("dev", "POST", "agents/deploy", { project: project.slug, agent: "reporter" })).agent as { id: string };
    const after = (await call("viewer", "GET", `library-agents?project=${project.id}`)).agents as Array<Record<string, unknown>>;
    expect(after.find((agent) => agent.itemId === reporterItem)?.deployed).toEqual({ agentId: deployed.id, version: 1 });

    expect(await call("viewer", "GET", `agents/${deployed.id}/heartbeat`)).toEqual({ heartbeat: "Check whether this week's report is due." });
    const quiet = (await call("dev", "POST", "agents/deploy", { project: project.slug, agent: "quiet" })).agent as { id: string };
    expect(await call("viewer", "GET", `agents/${quiet.id}/heartbeat`)).toEqual({ heartbeat: null });
  });

  test("monthly alert: owners and admins only, whole dollars or null", async () => {
    expect(await errorCode(call("dev", "POST", "credential/alert", { monthlyAlertUsd: 40 }))).toBe("forbidden");
    expect(await errorCode(call("owner", "POST", "credential/alert", { monthlyAlertUsd: "40" }))).toBe("validation_failed");
    expect(((await call("owner", "POST", "credential/alert", { monthlyAlertUsd: 40 })).credential as { monthlyAlertUsd: number }).monthlyAlertUsd).toBe(40);
    expect(((await call("owner", "POST", "credential/alert", { monthlyAlertUsd: null })).credential as { monthlyAlertUsd: null }).monthlyAlertUsd).toBe(null);
  });

  test("a run started from the Console is manual and keeps only what a person sets", async () => {
    const { run } = (await call("dev", "POST", "runs", {
      project: project.slug,
      agent: "reporter",
      prompt: "Write it.",
      trigger: "page",
      origin: { kind: "page" },
      idempotencyKey: `ui-${suffix}`,
    })) as { run: { id: string; trigger: string; origin: unknown } };
    expect(run.trigger).toBe("manual");
    expect(run.origin).toBe(null);
    const again = (await call("dev", "POST", "runs", { project: project.slug, agent: "reporter", prompt: "Write it.", idempotencyKey: `ui-${suffix}` })) as {
      run: { id: string };
    };
    expect(again.run.id).toBe(run.id);
    expect(await errorCode(call("dev", "POST", `runs/${run.id}/delivered`))).toBe("not_found");
    expect(await errorCode(call("viewer", "POST", "runs", { project: project.slug, agent: "reporter", prompt: "x" }))).toBe("forbidden");
  });
});

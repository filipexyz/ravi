import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";

// Phase 5 (the agent directory and requests between agents) through
// `routeLibraryRequest`, one test per CHECKS.md line. Runs only with LIBRARY_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at a migrated Console database.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `dir-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `dir-b-${suffix}` };
const laptop = randomUUID();
const server = randomUUID();

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `library-dir-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const viewerB = makeUser("viewerb", "viewer"); // reads only project B
const USERS = [owner, dev, viewerB];

async function call(
  user: TestUser,
  method: string,
  path: string,
  options: { body?: unknown; query?: string; installation?: string | null } = {},
): Promise<Res> {
  try {
    const result = await routeLibraryRequest({
      workspace: { user: { id: user.id }, organization: { id: orgId }, membership: { role: user.orgRole } },
      actor: {
        surface: "cli",
        requestId: randomUUID(),
        localInstallationId: options.installation === undefined ? laptop : options.installation,
        origin: "https://console.test",
      },
      method,
      segments: path.split("/").filter(Boolean),
      body: options.body ?? {},
      searchParams: new URLSearchParams(options.query ?? ""),
    });
    return { status: result.status, body: JSON.parse(JSON.stringify(result.payload)) };
  } catch (error) {
    if (error instanceof CliApiError) {
      return { status: error.status, body: { code: error.code, message: error.message, details: error.details } };
    }
    throw error;
  }
}

function expectStatus(res: Res, status: number, code?: string, reason?: string) {
  if (res.status !== status || (code && res.body?.code !== code) || (reason && res.body?.details?.reason !== reason)) {
    throw new Error(`expected ${status} ${code ?? ""} ${reason ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

const LAPTOP_AGENTS = [
  { id: "main", name: "Main", description: "General help", acceptsRequests: true },
  { id: "private", name: "Private", acceptsRequests: false },
  { id: "clinica", name: "Clínica", description: "Marca consultas", project: projectA.slug, acceptsRequests: true },
];
const SERVER_AGENTS = [{ id: "ops", name: "Ops", description: "Deploys and logs", acceptsRequests: true }];

describeDb("library directory and requests (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `library-dir-${suffix}`, name: "Library directory test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([{ projectId: projectB.id, userId: viewerB.id, role: "viewer" }]);
    await db.insert(schema.localInstallations).values([
      { id: laptop, organizationId: orgId, userId: owner.id, name: "laptop" },
      { id: server, organizationId: orgId, userId: dev.id, name: "server" },
    ]);
    expectStatus(await call(owner, "POST", "pins/sync", { body: { agents: LAPTOP_AGENTS } }), 200);
    expectStatus(await call(dev, "POST", "pins/sync", { body: { agents: SERVER_AGENTS }, installation: server }), 200);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("the directory lists reported agents the caller may see, with description, online state and the request opt-in", async () => {
    const all = expectStatus(await call(dev, "GET", "directory", { installation: server }), 200);
    expect(all.agents.map((entry: J) => `${entry.installation.name}/${entry.agent.id}`).sort()).toEqual([
      "laptop/clinica",
      "laptop/main",
      "laptop/private",
      "server/ops",
    ]);
    const main = all.agents.find((entry: J) => entry.agent.id === "main");
    expect(main).toMatchObject({ online: true, acceptsRequests: true, self: false, agent: { description: "General help" } });
    expect(Object.keys(main.agent).sort()).toEqual(["description", "id", "model", "name", "project", "provider"]);
    expect(all.can.ask).toBe(true);

    // A viewer of project B sees org-wide agents only; project A's agent is hidden.
    const viewer = expectStatus(await call(viewerB, "GET", "directory", { installation: null }), 200);
    expect(viewer.agents.map((entry: J) => entry.agent.id).sort()).toEqual(["main", "ops", "private"]);
    expect(viewer.can.ask).toBe(false);
    expectStatus(await call(viewerB, "GET", "directory", { query: `project=${projectA.slug}`, installation: null }), 404, "NOT_FOUND");

    const searched = expectStatus(await call(owner, "GET", "directory", { query: "q=consultas" }), 200);
    expect(searched.agents.map((entry: J) => entry.agent.id)).toEqual(["clinica"]);
  });

  test("a request needs a linked installation, a visible agent that takes requests, on another installation", async () => {
    const to = (agentId: string, installationId = laptop) => ({ installationId, agentId });
    expectStatus(await call(dev, "POST", "requests", { body: { to: to("main"), message: "hi" }, installation: null }), 409, "CONFLICT", "no_installation");
    expectStatus(await call(viewerB, "POST", "requests", { body: { to: to("main"), message: "hi" }, installation: server }), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(dev, "POST", "requests", { body: { to: to("ghost"), message: "hi" }, installation: server }), 404, "NOT_FOUND");
    expectStatus(await call(dev, "POST", "requests", { body: { to: to("private"), message: "hi" }, installation: server }), 409, "CONFLICT", "not_accepting");
    expectStatus(await call(owner, "POST", "requests", { body: { to: to("main"), message: "hi" } }), 409, "CONFLICT", "same_installation");
    expectStatus(await call(dev, "POST", "requests", { body: { to: to("main"), message: "" }, installation: server }), 400, "PAYLOAD_INVALID");

    const sent = expectStatus(
      await call(dev, "POST", "requests", { body: { to: to("main"), message: "Qual o status do deploy?", agent: { id: "ops" } }, installation: server }),
      201,
    );
    expect(sent.request).toMatchObject({
      status: "pending",
      direction: "sent",
      from: { installation: { id: server, name: "server" }, agentId: "ops", user: { id: dev.id } },
      to: { installation: { id: laptop, name: "laptop" }, agentId: "main" },
    });
  });

  test("the target pulls a request once, answers it, and the sender pulls the answer once", async () => {
    const sent = expectStatus(
      await call(dev, "POST", "requests", { body: { to: { installationId: laptop, agentId: "clinica" }, message: "Agenda de amanhã?" }, installation: server }),
      201,
    ).request;
    expect(sent.project).toMatchObject({ slug: projectA.slug });

    const pulled = expectStatus(await call(owner, "POST", "requests/pull"), 200);
    expect(pulled.requests.map((request: J) => request.status)).toEqual(["delivered", "delivered"]);
    expect(expectStatus(await call(owner, "POST", "requests/pull"), 200).requests).toEqual([]);

    // Only the target answers; the sender can't, and can't cancel a delivered request.
    expectStatus(await call(dev, "POST", `requests/${sent.id}/reply`, { body: { reply: "x" }, installation: server }), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(dev, "POST", `requests/${sent.id}/cancel`, { installation: server }), 409, "CONFLICT", "not_pending");
    expectStatus(await call(owner, "POST", `requests/${sent.id}/reply`, { body: { reply: "a", failure: "b" } }), 400, "PAYLOAD_INVALID");
    const answered = expectStatus(await call(owner, "POST", `requests/${sent.id}/reply`, { body: { reply: "Três consultas." } }), 200);
    expect(answered.request).toMatchObject({ status: "answered", reply: "Três consultas.", direction: "received" });
    expectStatus(await call(owner, "POST", `requests/${sent.id}/reply`, { body: { reply: "again" } }), 409, "CONFLICT", "not_open");

    const other = pulled.requests.find((request: J) => request.id !== sent.id);
    expectStatus(await call(owner, "POST", `requests/${other.id}/reply`, { body: { failure: "The agent is busy." } }), 200);

    const replies = expectStatus(await call(dev, "POST", "requests/replies/pull", { installation: server }), 200);
    expect(replies.requests.map((request: J) => [request.id, request.status]).sort()).toEqual(
      [
        [sent.id, "answered"],
        [other.id, "failed"],
      ].sort(),
    );
    expect(expectStatus(await call(dev, "POST", "requests/replies/pull", { installation: server }), 200).requests).toEqual([]);

    const closed = expectStatus(await call(dev, "GET", "requests", { query: "box=sent&state=closed", installation: server }), 200);
    expect(closed.requests).toHaveLength(2);
    expectStatus(await call(viewerB, "GET", `requests/${sent.id}`, { installation: null }), 409, "CONFLICT", "no_installation");
  });

  test("a pending request can be cancelled; one nobody answers in time expires and goes back to the sender", async () => {
    const pending = expectStatus(
      await call(dev, "POST", "requests", { body: { to: { installationId: laptop, agentId: "main" }, message: "cancel me" }, installation: server }),
      201,
    ).request;
    expect(expectStatus(await call(dev, "POST", `requests/${pending.id}/cancel`, { installation: server }), 200).request.status).toBe("cancelled");

    const late = expectStatus(
      await call(dev, "POST", "requests", { body: { to: { installationId: laptop, agentId: "main" }, message: "too late" }, installation: server }),
      201,
    ).request;
    await db.update(schema.agentRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.agentRequests.id, late.id));
    expect(expectStatus(await call(owner, "POST", "requests/pull"), 200).requests).toEqual([]);
    const replies = expectStatus(await call(dev, "POST", "requests/replies/pull", { installation: server }), 200);
    expect(replies.requests.map((request: J) => [request.id, request.status])).toEqual([[late.id, "expired"]]);
  });

  test("an installation has at most 20 open requests out at once", async () => {
    for (let index = 0; index < 20; index += 1) {
      expectStatus(
        await call(dev, "POST", "requests", { body: { to: { installationId: laptop, agentId: "main" }, message: `n${index}` }, installation: server }),
        201,
      );
    }
    expectStatus(
      await call(dev, "POST", "requests", { body: { to: { installationId: laptop, agentId: "main" }, message: "one more" }, installation: server }),
      409,
      "CONFLICT",
      "too_many_open",
    );
  });
});

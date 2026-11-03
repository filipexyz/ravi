import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";

// Phase 4 (agent definitions under `agents/...`) through `routeLibraryRequest`,
// one test per CHECKS.md line. Runs only with LIBRARY_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at a migrated Console database.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `agt-a-${suffix}` };

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `library-agent-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const USERS = [owner, dev];

async function call(user: TestUser, method: string, path: string, options: { body?: unknown; query?: string } = {}): Promise<Res> {
  try {
    const result = await routeLibraryRequest({
      workspace: { user: { id: user.id }, organization: { id: orgId }, membership: { role: user.orgRole } },
      actor: { surface: "cli", requestId: randomUUID(), localInstallationId: null, origin: "https://console.test" },
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

function agentBody(
  slug: string,
  input: { manifest?: unknown; extra?: { path: string; content: string }[]; scope?: "org" | "project"; project?: string; submit?: boolean } = {},
) {
  const files = [{ path: "AGENTS.md", content: `# ${slug}\n\nAnswers the clinic's WhatsApp and books appointments.` }];
  if (input.manifest !== undefined) {
    files.push({ path: "agent.json", content: typeof input.manifest === "string" ? input.manifest : JSON.stringify(input.manifest) });
  }
  return {
    scope: input.scope ?? "org",
    ...(input.project ? { project: input.project } : {}),
    slug,
    description: "Triage for the clinic",
    files: [...files, ...(input.extra ?? [])],
    ...(input.submit !== undefined ? { submit: input.submit } : {}),
  };
}

describeDb("library agents (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `library-agent-${suffix}`, name: "Library agents test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([{ id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" }]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("an agent definition is AGENTS.md, an optional HEARTBEAT.md and a validated agent.json, nothing else", async () => {
    expectStatus(await call(owner, "POST", "agents", { body: agentBody("triagem", { extra: [{ path: "routes.json", content: "{}" }] }) }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "agents", { body: agentBody("triagem", { manifest: "{not json" }) }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "agents", { body: agentBody("triagem", { manifest: { provider: "codex", token: "x" } }) }), 400, "PAYLOAD_INVALID");
    expectStatus(await call(owner, "POST", "agents", { body: agentBody("triagem", { manifest: { skills: ["../etc"] } }) }), 400, "PAYLOAD_INVALID");
    expectStatus(
      await call(owner, "POST", "agents", { body: { ...agentBody("triagem"), files: [{ path: "SKILL.md", content: "x" }] } }),
      400,
      "PAYLOAD_INVALID",
    );

    const manifest = { provider: "codex", model: "gpt-5", profile: "chat-only", skills: ["org/tom-de-voz", "pages"] };
    const published = expectStatus(
      await call(owner, "POST", "agents", {
        body: agentBody("triagem", { manifest, extra: [{ path: "HEARTBEAT.md", content: "- check the queue" }] }),
      }),
      201,
    );
    expect(published.item).toMatchObject({ ref: "org/triagem", kind: "agent", version: 1 });

    const shown = expectStatus(await call(dev, "GET", "agents/org/triagem"), 200);
    expect(shown.version.agent).toEqual(manifest);
    expect(shown.version.files.map((file: J) => file.path)).toEqual(["AGENTS.md", "HEARTBEAT.md", "agent.json"]);
  });

  test("an agent may only require skills its scope's agents can see", async () => {
    expectStatus(
      await call(owner, "POST", "agents", { body: agentBody("misplaced", { manifest: { skills: [`${projectA.slug}/agenda`] } }) }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(
      await call(owner, "POST", "agents", {
        body: agentBody("other-project", { scope: "project", project: projectA.slug, manifest: { skills: ["elsewhere/agenda"] } }),
      }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(
      await call(owner, "POST", "agents", {
        body: agentBody("recepcao", { scope: "project", project: projectA.slug, manifest: { skills: [`${projectA.slug}/agenda`, "org/tom"] } }),
      }),
      201,
    );
  });

  test("agents and skills are separate: search, slugs, pins and system names", async () => {
    // A skill may reuse an agent's slug, and reserved skill names are free for agents.
    expectStatus(
      await call(owner, "POST", "skills", {
        body: { scope: "org", slug: "triagem", description: "A skill", files: [{ path: "SKILL.md", content: "---\nname: triagem\n---\nx" }] },
      }),
      201,
    );
    expectStatus(await call(owner, "POST", "agents", { body: agentBody("pages") }), 201);

    const agents = expectStatus(await call(dev, "GET", "agents", { query: "q=clinic" }), 200);
    expect(agents.items.every((item: J) => item.kind === "agent")).toBe(true);
    expect(agents.items.map((item: J) => item.slug)).toContain("triagem");
    const skills = expectStatus(await call(dev, "GET", "skills", { query: "q=triagem" }), 200);
    expect(skills.items.map((item: J) => item.kind)).toEqual(["skill"]);

    expectStatus(await call(owner, "GET", "agents/org/triagem/pins"), 404, "NOT_FOUND");
    expectStatus(await call(owner, "POST", "agents/org/triagem/pin", { body: { agentId: "main" } }), 404, "NOT_FOUND");
  });

  test("agent proposals go through the same review and notify as library.agent.*", async () => {
    const created = expectStatus(await call(dev, "POST", "agents/proposals", { body: agentBody("triagem", { manifest: { profile: "chat-only" }, submit: true }) }), 201);
    expect(created.proposal).toMatchObject({ ref: "org/triagem", status: "proposed", baseVersion: 1 });
    const [item] = await db
      .select()
      .from(schema.agentInboxItems)
      .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.eventType, "library.agent.proposed")));
    expect(item?.title).toBe("An agent change is waiting for review");
    const published = expectStatus(await call(owner, "POST", `agents/org/triagem/proposals/${created.proposal.number}/publish`), 200);
    expect(published.item).toMatchObject({ kind: "agent", version: 2 });
    expect(expectStatus(await call(dev, "GET", "agents/org/triagem"), 200).version.agent.profile).toBe("chat-only");
  });
});

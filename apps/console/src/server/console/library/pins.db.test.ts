import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";

// Phase 3 (pins and installation sync) through `routeLibraryRequest`, one test
// per CHECKS.md line. Runs only with LIBRARY_TEST_DATABASE_URL (and
// DATABASE_URL) pointing at a migrated Console database.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `pin-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `pin-b-${suffix}` };
const laptop = randomUUID();
const server = randomUUID();

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `library-pin-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const projAdmin = makeUser("projadmin", "viewer"); // project_admin of A
const USERS = [owner, dev, projAdmin];

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

function publishBody(slug: string, input: { body?: string; scope?: "org" | "project"; project?: string } = {}) {
  return {
    scope: input.scope ?? "org",
    ...(input.project ? { project: input.project } : {}),
    slug,
    description: "A skill",
    files: [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: A skill\n---\n${input.body ?? "Steps."}` }],
  };
}

const AGENTS = [
  { id: "main", name: "Main", provider: "codex", project: null },
  { id: "clinica", name: "Clínica", provider: "claude", project: projectA.slug },
];

describeDb("library pins (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `library-pin-${suffix}`, name: "Library pins test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([{ projectId: projectA.id, userId: projAdmin.id, role: "project_admin" }]);
    await db.insert(schema.localInstallations).values([
      { id: laptop, organizationId: orgId, userId: owner.id, name: "laptop" },
      { id: server, organizationId: orgId, userId: dev.id, name: "server" },
    ]);
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("tom") }), 201);
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("agenda", { scope: "project", project: projectA.slug }) }), 201);
    expectStatus(await call(owner, "POST", "pins/sync", { body: { agents: AGENTS } }), 200);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("only a scope reviewer pins or unpins; agents never pin; a project item pins only to an agent in that project", async () => {
    expectStatus(await call(dev, "POST", "skills/org/tom/pin", { body: { agentId: "main" } }), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(owner, "POST", "skills/org/tom/pin", { body: { agentId: "main", agent: { id: "main" } } }), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(owner, "POST", "skills/org/tom/pin", { body: { agentId: "ghost" } }), 404, "NOT_FOUND");

    const pinned = expectStatus(await call(owner, "POST", "skills/org/tom/pin", { body: { agentId: "main" } }), 201);
    expect(pinned.pin).toMatchObject({ installation: { id: laptop, name: "laptop" }, agent: { id: "main", name: "Main" } });
    expect(expectStatus(await call(owner, "POST", "skills/org/tom/pin", { body: { agentId: "main" } }), 200).created).toBe(false);

    expectStatus(
      await call(projAdmin, "POST", `skills/${projectA.slug}/agenda/pin`, { body: { agentId: "main" } }),
      409,
      "CONFLICT",
      "agent_out_of_scope",
    );
    expectStatus(await call(projAdmin, "POST", `skills/${projectA.slug}/agenda/pin`, { body: { agentId: "clinica" } }), 201);
    // A project admin is not an org reviewer.
    expectStatus(await call(projAdmin, "POST", "skills/org/tom/unpin", { body: { agentId: "main" } }), 403, "ORG_ACCESS_DENIED");

    const listed = expectStatus(await call(dev, "GET", "skills/org/tom/pins"), 200);
    expect(listed.can.pin).toBe(false);
    expect(listed.pins).toHaveLength(1);
    expect(listed.pins[0]).toMatchObject({ agent: { id: "main", reported: true }, pinnedBy: { name: expect.any(String) } });

    // The UI pins on another installation by id; agents come from its report.
    const picker = expectStatus(await call(owner, "GET", "installations", { installation: null }), 200);
    expect(picker.installations.map((installation: J) => installation.name)).toEqual(["laptop"]);
    expectStatus(await call(dev, "GET", "installations"), 403, "ORG_ACCESS_DENIED");
    const projectPicker = expectStatus(await call(projAdmin, "GET", "installations", { query: `project=${projectA.slug}` }), 200);
    expect(projectPicker.installations[0].agents.map((agent: J) => agent.id)).toEqual(["clinica"]);

    expect(expectStatus(await call(owner, "POST", "skills/org/tom/unpin", { body: { agentId: "main" } }), 200).removed).toBe(true);
    expect(expectStatus(await call(owner, "POST", "skills/org/tom/unpin", { body: { agentId: "main" } }), 200).removed).toBe(false);
    expectStatus(await call(owner, "POST", "skills/org/tom/pin", { body: { agentId: "main" } }), 201);
  });

  test("pin sync replaces reported agents and answers only published, non-archived pins at the latest version", async () => {
    expectStatus(await call(owner, "POST", "pins/sync", { body: { agents: AGENTS }, installation: null }), 409, "CONFLICT", "no_installation");

    let sync = expectStatus(await call(owner, "POST", "pins/sync", { body: { agents: AGENTS } }), 200);
    expect(sync.installation).toEqual({ id: laptop, name: "laptop" });
    expect(sync.pins.map((pin: J) => [pin.agentId, pin.ref, pin.item.version])).toEqual([
      ["clinica", `${projectA.slug}/agenda`, 1],
      ["main", "org/tom", 1],
    ]);
    const before = sync.revision;

    expectStatus(await call(owner, "POST", "skills", { body: publishBody("tom", { body: "Better steps." }) }), 201);
    sync = expectStatus(await call(owner, "GET", "pins"), 200);
    expect(sync.pins.find((pin: J) => pin.ref === "org/tom").item.version).toBe(2);
    expect(sync.revision).not.toBe(before);

    // Another installation sees none of the laptop's pins.
    expect(expectStatus(await call(dev, "POST", "pins/sync", { body: { agents: [] }, installation: server }), 200).pins).toEqual([]);

    // An agent the laptop stops reporting disappears from the picker; its pin stays, unreported.
    expectStatus(await call(owner, "POST", "pins/sync", { body: { agents: [AGENTS[1]] } }), 200);
    const listed = expectStatus(await call(owner, "GET", "skills/org/tom/pins"), 200);
    expect(listed.pins[0].agent).toMatchObject({ id: "main", reported: false });
    expectStatus(await call(owner, "POST", "pins/sync", { body: { agents: AGENTS } }), 200);
  });

  test("archiving drops an item's pins from sync and restoring brings them back", async () => {
    expectStatus(await call(owner, "POST", "skills/org/tom/archive"), 200);
    let sync = expectStatus(await call(owner, "GET", "pins"), 200);
    expect(sync.pins.map((pin: J) => pin.ref)).toEqual([`${projectA.slug}/agenda`]);
    expectStatus(await call(owner, "POST", "skills/org/tom/pin", { body: { agentId: "main" } }), 409, "CONFLICT", "not_published");

    expectStatus(await call(owner, "POST", "skills", { body: publishBody("tom", { body: "Restored." }) }), 201);
    sync = expectStatus(await call(owner, "GET", "pins"), 200);
    expect(sync.pins.map((pin: J) => pin.ref)).toEqual([`${projectA.slug}/agenda`, "org/tom"]);
  });
});

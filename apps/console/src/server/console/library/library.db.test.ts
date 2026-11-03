import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";

// Integration tests through `routeLibraryRequest`, one per CHECKS.md line.
// Runs only with LIBRARY_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database. Creates its own organizations, users and
// projects, and deletes them afterwards.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" | "billing" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const otherOrgId = randomUUID();
const projectA = { id: randomUUID(), slug: `lib-a-${suffix}` };
const projectB = { id: randomUUID(), slug: `lib-b-${suffix}` };

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `library-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const projAdmin = makeUser("projadmin", "viewer"); // project_admin of A
const viewerA = makeUser("viewera", "viewer"); // project viewer of A
const outsider = makeUser("outsider", "viewer"); // no project membership
const billing = makeUser("billing", "billing");
const stranger = makeUser("stranger", "owner"); // owner of the other org
const USERS = [owner, dev, projAdmin, viewerA, outsider, billing, stranger];

async function call(
  user: TestUser,
  method: string,
  path: string,
  options: { body?: unknown; query?: string; organizationId?: string } = {},
): Promise<Res> {
  try {
    const result = await routeLibraryRequest({
      workspace: {
        user: { id: user.id },
        organization: { id: options.organizationId ?? (user === stranger ? otherOrgId : orgId) },
        membership: { role: user.orgRole },
      },
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

function expectStatus(res: Res, status: number, code?: string) {
  if (res.status !== status || (code && res.body?.code !== code)) {
    throw new Error(`expected ${status} ${code ?? ""}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function skillBody(input: {
  scope: "org" | "project";
  project?: string;
  slug: string;
  description?: string;
  body?: string;
  files?: { path: string; content: string }[];
  baseVersion?: number;
  externalAllowed?: boolean;
}) {
  const content = `---\nname: ${input.slug}\ndescription: ${input.description ?? "A skill"}\n---\n${input.body ?? "Steps."}`;
  return {
    scope: input.scope,
    ...(input.project ? { project: input.project } : {}),
    slug: input.slug,
    description: input.description ?? "A skill",
    ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
    ...(input.externalAllowed !== undefined ? { externalAllowed: input.externalAllowed } : {}),
    files: input.files ?? [{ path: "SKILL.md", content }],
  };
}

const auditCount = async (action: string) => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.organizationId, orgId), eq(schema.auditEvents.action, action)));
  return Number(row?.count ?? 0);
};

describeDb("library (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([
      { id: orgId, slug: `library-${suffix}`, name: "Library test" },
      { id: otherOrgId, slug: `library-other-${suffix}`, name: "Other org" },
    ]);
    await db.insert(schema.organizationMemberships).values([
      ...USERS.filter((user) => user !== stranger).map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })),
      { organizationId: otherOrgId, userId: stranger.id, role: "owner" as const },
    ]);
    await db.insert(schema.projects).values([
      { id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" },
      { id: projectB.id, organizationId: orgId, slug: projectB.slug, name: "Project B" },
    ]);
    await db.insert(schema.projectMemberships).values([
      { projectId: projectA.id, userId: projAdmin.id, role: "project_admin" },
      { projectId: projectA.id, userId: viewerA.id, role: "viewer" },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM organizations WHERE id IN (${orgId}::uuid, ${otherOrgId}::uuid)`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("owners publish org skills; project admins publish project skills; others cannot", async () => {
    const created = expectStatus(
      await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "tom-de-voz", description: "Como a clínica fala" }) }),
      201,
    );
    expect(created.item).toMatchObject({ ref: "org/tom-de-voz", scope: "org", project: null, version: 1, archived: false });
    expect(created.unchanged).toBe(false);

    expectStatus(await call(dev, "POST", "skills", { body: skillBody({ scope: "org", slug: "dev-skill" }) }), 403, "ORG_ACCESS_DENIED");
    expectStatus(
      await call(dev, "POST", "skills", { body: skillBody({ scope: "project", project: projectA.slug, slug: "dev-skill" }) }),
      403,
      "PROJECT_ACCESS_DENIED",
    );
    expectStatus(
      await call(viewerA, "POST", "skills", { body: skillBody({ scope: "project", project: projectA.slug, slug: "viewer-skill" }) }),
      403,
      "PROJECT_ACCESS_DENIED",
    );

    const project = expectStatus(
      await call(projAdmin, "POST", "skills", {
        body: skillBody({ scope: "project", project: projectA.slug, slug: "agenda-semanal", description: "Agenda da semana", body: "Relatório semanal para o cliente" }),
      }),
      201,
    );
    expect(project.item).toMatchObject({ ref: `${projectA.slug}/agenda-semanal`, scope: "project", project: { slug: projectA.slug } });
    expect(await auditCount("library.skill.published")).toBe(2);
  });

  test("billing has no Library and another org sees nothing", async () => {
    expectStatus(await call(billing, "GET", "skills"), 403, "ORG_ACCESS_DENIED");
    const other = expectStatus(await call(stranger, "GET", "skills"), 200);
    expect(other.items).toEqual([]);
    expectStatus(await call(stranger, "GET", "skills/org/tom-de-voz"), 404, "NOT_FOUND");
  });

  test("slugs collide across org and project scopes but not between projects; Ravi's names are reserved", async () => {
    expect(
      expectStatus(
        await call(owner, "POST", "skills", { body: skillBody({ scope: "project", project: projectB.slug, slug: "tom-de-voz" }) }),
        409,
        "CONFLICT",
      ).details,
    ).toMatchObject({ reason: "slug_taken_in_org" });
    expect(
      expectStatus(await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "agenda-semanal" }) }), 409, "CONFLICT").details,
    ).toMatchObject({ reason: "slug_taken_in_project" });
    expectStatus(
      await call(owner, "POST", "skills", { body: skillBody({ scope: "project", project: projectB.slug, slug: "agenda-semanal" }) }),
      201,
    );
    expect(
      expectStatus(await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "pages" }) }), 409, "CONFLICT").details,
    ).toMatchObject({ reason: "slug_reserved" });
  });

  test("project items need read on their project; hidden items are 404 and never searched", async () => {
    expectStatus(await call(viewerA, "GET", `skills/${projectA.slug}/agenda-semanal`), 200);
    expectStatus(await call(outsider, "GET", `skills/${projectA.slug}/agenda-semanal`), 404, "NOT_FOUND");
    expectStatus(await call(outsider, "GET", "skills/org/tom-de-voz"), 200);
    expectStatus(await call(outsider, "GET", "skills/agenda-semanal", { query: `project=${projectA.slug}` }), 404, "NOT_FOUND");
    expectStatus(await call(outsider, "GET", "skills", { query: `project=${projectA.slug}` }), 403, "PROJECT_ACCESS_DENIED");

    const orgOnly = expectStatus(await call(outsider, "GET", "skills", { query: "q=agenda" }), 200);
    expect(orgOnly.items).toEqual([]);
    const inA = expectStatus(await call(viewerA, "GET", "skills", { query: `q=agenda&project=${projectA.slug}` }), 200);
    expect(inA.items.map((item: J) => item.ref)).toEqual([`${projectA.slug}/agenda-semanal`]);
  });

  test("a bare slug resolves in the caller's view", async () => {
    const fromA = expectStatus(await call(viewerA, "GET", "skills/agenda-semanal", { query: `project=${projectA.slug}` }), 200);
    expect(fromA.item.ref).toBe(`${projectA.slug}/agenda-semanal`);
    expect(fromA.version.files.map((file: J) => file.path)).toEqual(["SKILL.md"]);
    const fromB = expectStatus(await call(owner, "GET", "skills/agenda-semanal", { query: `project=${projectB.slug}` }), 200);
    expect(fromB.item.ref).toBe(`${projectB.slug}/agenda-semanal`);
    expectStatus(await call(owner, "GET", "skills/agenda-semanal"), 404, "NOT_FOUND");
    const org = expectStatus(await call(dev, "GET", "skills/tom-de-voz"), 200);
    expect(org.item.ref).toBe("org/tom-de-voz");
  });

  test("files are validated before anything is written", async () => {
    expectStatus(
      await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "bad", files: [{ path: "README.md", content: "x" }] }) }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(
      await call(owner, "POST", "skills", {
        body: skillBody({ scope: "org", slug: "bad", files: [{ path: "SKILL.md", content: "x" }, { path: "../etc", content: "x" }] }),
      }),
      400,
      "PAYLOAD_INVALID",
    );
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.libraryItems)
      .where(and(eq(schema.libraryItems.organizationId, orgId), eq(schema.libraryItems.slug, "bad")));
    expect(Number(row?.count)).toBe(0);
  });

  test("identical content writes no version; a stale base is refused; a new version supersedes", async () => {
    const same = expectStatus(
      await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "tom-de-voz", description: "Como a clínica fala", baseVersion: 1 }) }),
      200,
    );
    expect(same).toMatchObject({ unchanged: true, version: { number: 1 } });

    const relabeled = expectStatus(
      await call(owner, "POST", "skills", {
        body: { ...skillBody({ scope: "org", slug: "tom-de-voz", description: "Como a clínica fala" }), externalAllowed: true },
      }),
      200,
    );
    expect(relabeled).toMatchObject({ unchanged: true, item: { externalAllowed: true, version: 1 } });

    const stale = expectStatus(
      await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "tom-de-voz", body: "v2", baseVersion: 0 }) }),
      409,
      "CONFLICT",
    );
    expect(stale.details).toMatchObject({ reason: "stale_base", currentVersion: 1 });

    const v2 = expectStatus(
      await call(owner, "POST", "skills", {
        body: skillBody({ scope: "org", slug: "tom-de-voz", description: "Como a clínica fala", body: "v2", baseVersion: 1 }),
      }),
      201,
    );
    expect(v2.version.number).toBe(2);
    const versions = expectStatus(await call(dev, "GET", "skills/org/tom-de-voz/versions"), 200);
    expect(versions.versions.map((version: J) => [version.number, version.status])).toEqual([
      [2, "published"],
      [1, "superseded"],
    ]);
    const old = expectStatus(await call(dev, "GET", "skills/org/tom-de-voz", { query: "version=1" }), 200);
    expect(old.version.files[0].content).toContain("Steps.");
    const current = expectStatus(await call(dev, "GET", "skills/org/tom-de-voz"), 200);
    expect(current.version.files[0].content).toContain("v2");
  });

  test("search ignores case and accents, matches prefixes and ranks the name first", async () => {
    expectStatus(
      await call(owner, "POST", "skills", {
        body: skillBody({ scope: "org", slug: "triagem-whatsapp", description: "Atende pacientes", body: "Use a agenda da clínica" }),
      }),
      201,
    );
    const accents = expectStatus(await call(dev, "GET", "skills", { query: "q=CLINICA" }), 200);
    expect(accents.items.map((item: J) => item.ref)).toContain("org/tom-de-voz");
    const prefix = expectStatus(await call(dev, "GET", "skills", { query: "q=triag" }), 200);
    expect(prefix.items.map((item: J) => item.ref)).toEqual(["org/triagem-whatsapp"]);
    const ranked = expectStatus(await call(owner, "GET", "skills", { query: `q=agenda&project=${projectA.slug}` }), 200);
    expect(ranked.items.map((item: J) => item.ref)).toEqual([`${projectA.slug}/agenda-semanal`, "org/triagem-whatsapp"]);
    expect(ranked.items[0].score).toBeGreaterThan(ranked.items[1].score);
    const all = expectStatus(await call(dev, "GET", "skills", { query: "limit=1" }), 200);
    expect(all.items).toHaveLength(1);
  });

  test("archive hides an item, keeps its slug, and a new publish restores it", async () => {
    expectStatus(await call(dev, "POST", "skills/org/triagem-whatsapp/archive"), 403, "ORG_ACCESS_DENIED");
    const archived = expectStatus(await call(owner, "POST", "skills/org/triagem-whatsapp/archive"), 200);
    expect(archived.item.archived).toBe(true);
    expectStatus(await call(owner, "POST", "skills/org/triagem-whatsapp/archive"), 200);
    expect(await auditCount("library.skill.archived")).toBe(1);
    expectStatus(await call(dev, "GET", "skills/org/triagem-whatsapp"), 404, "NOT_FOUND");
    const search = expectStatus(await call(dev, "GET", "skills", { query: "q=triagem" }), 200);
    expect(search.items).toEqual([]);
    expect(
      expectStatus(
        await call(projAdmin, "POST", "skills", { body: skillBody({ scope: "project", project: projectA.slug, slug: "triagem-whatsapp" }) }),
        409,
        "CONFLICT",
      ).details,
    ).toMatchObject({ reason: "slug_taken_in_org" });
    const restored = expectStatus(
      await call(owner, "POST", "skills", { body: skillBody({ scope: "org", slug: "triagem-whatsapp", body: "back" }) }),
      201,
    );
    expect(restored.item).toMatchObject({ archived: false, version: 2 });
    expect(await auditCount("library.skill.restored")).toBe(1);
  });

  test("project admins archive their project's items only", async () => {
    expectStatus(await call(projAdmin, "POST", `skills/${projectB.slug}/agenda-semanal/archive`), 404, "NOT_FOUND");
    expectStatus(await call(viewerA, "POST", `skills/${projectA.slug}/agenda-semanal/archive`), 403, "PROJECT_ACCESS_DENIED");
    expectStatus(await call(projAdmin, "POST", `skills/${projectA.slug}/agenda-semanal/archive`), 200);
  });
});

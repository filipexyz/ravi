import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import { CliApiError } from "@/server/cli/errors";
import { db, schema } from "@/server/db";

import { routeLibraryRequest } from "./cli";

// Phase 2 (drafts, proposals, review comments, revert) through
// `routeLibraryRequest`, one test per CHECKS.md line. Runs only with
// LIBRARY_TEST_DATABASE_URL (and DATABASE_URL) pointing at a migrated Console
// database, like library.db.test.ts.
const url = process.env.LIBRARY_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type J = any;
type Res = { status: number; body: J };
type TestUser = { id: string; email: string; orgRole: "owner" | "admin" | "developer" | "viewer" };

const suffix = randomUUID().slice(0, 8);
const orgId = randomUUID();
const projectA = { id: randomUUID(), slug: `prop-a-${suffix}` };

function makeUser(label: string, orgRole: TestUser["orgRole"]): TestUser {
  return { id: randomUUID(), email: `library-prop-${suffix}-${label}@example.test`, orgRole };
}

const owner = makeUser("owner", "owner");
const dev = makeUser("dev", "developer");
const dev2 = makeUser("dev2", "developer");
const viewer = makeUser("viewer", "viewer"); // org viewer, project viewer of A
const projDev = makeUser("projdev", "viewer"); // project developer of A
const projAdmin = makeUser("projadmin", "viewer"); // project_admin of A
const outsider = makeUser("outsider", "viewer"); // no project membership
const USERS = [owner, dev, dev2, viewer, projDev, projAdmin, outsider];

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

function skillFiles(slug: string, body = "Steps.", extra: { path: string; content: string }[] = []) {
  return [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: A skill\n---\n${body}` }, ...extra];
}

function proposalBody(input: {
  scope?: "org" | "project";
  project?: string;
  slug: string;
  body?: string;
  description?: string;
  submit?: boolean;
  baseVersion?: number;
  agent?: { id: string };
  note?: string;
}) {
  return {
    scope: input.scope ?? "org",
    ...(input.project ? { project: input.project } : {}),
    slug: input.slug,
    description: input.description ?? "A skill",
    files: skillFiles(input.slug, input.body),
    ...(input.submit !== undefined ? { submit: input.submit } : {}),
    ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
}

function publishBody(slug: string, body = "Steps.") {
  return { scope: "org", slug, description: "A skill", files: skillFiles(slug, body) };
}

const inboxItems = async (eventType: string) =>
  db
    .select()
    .from(schema.agentInboxItems)
    .where(and(eq(schema.agentInboxItems.organizationId, orgId), eq(schema.agentInboxItems.eventType, eventType)));

describeDb("library proposals (db)", () => {
  beforeAll(async () => {
    await db.insert(schema.users).values(USERS.map((user) => ({ id: user.id, primaryEmail: user.email, displayName: user.email.split("@")[0] })));
    await db.insert(schema.organizations).values([{ id: orgId, slug: `library-prop-${suffix}`, name: "Library proposals test" }]);
    await db.insert(schema.organizationMemberships).values(USERS.map((user) => ({ organizationId: orgId, userId: user.id, role: user.orgRole })));
    await db.insert(schema.projects).values([{ id: projectA.id, organizationId: orgId, slug: projectA.slug, name: "Project A" }]);
    await db.insert(schema.projectMemberships).values([
      { projectId: projectA.id, userId: viewer.id, role: "viewer" },
      { projectId: projectA.id, userId: projDev.id, role: "developer" },
      { projectId: projectA.id, userId: projAdmin.id, role: "project_admin" },
    ]);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM agent_inbox_items WHERE organization_id = ${orgId}::uuid`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}::uuid`);
    await db.delete(schema.users).where(inArray(schema.users.id, USERS.map((user) => user.id)));
  });

  test("developers draft and propose; only the author edits, submits or withdraws; only scope admins publish, reject or revert, and never with agent set", async () => {
    expectStatus(await call(viewer, "POST", "skills/proposals", { body: proposalBody({ slug: "roles-a" }) }), 403, "ORG_ACCESS_DENIED");
    expectStatus(
      await call(outsider, "POST", "skills/proposals", { body: proposalBody({ scope: "project", project: projectA.slug, slug: "roles-p" }) }),
      403,
      "PROJECT_ACCESS_DENIED",
    );
    const draft = expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "roles-a" }) }), 201);
    expect(draft.proposal).toMatchObject({ ref: "org/roles-a", number: 1, status: "draft", baseVersion: 0, round: 1 });
    expect(draft.proposal.can).toEqual({ edit: true, submit: true, withdraw: true, publish: false, reject: false });

    expectStatus(await call(dev2, "POST", "skills/org/roles-a/proposals/1/submit"), 404); // drafts are private
    expectStatus(await call(owner, "POST", "skills/org/roles-a/proposals/1/submit"), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(owner, "POST", "skills/org/roles-a/proposals/1/publish"), 409, "CONFLICT", "not_proposed");
    const submitted = expectStatus(await call(dev, "POST", "skills/org/roles-a/proposals/1/submit"), 200);
    expect(submitted.proposal.status).toBe("proposed");
    expectStatus(await call(dev2, "POST", "skills/org/roles-a/proposals/1/update", { body: { description: "x", files: skillFiles("roles-a") } }), 403);
    expectStatus(await call(dev, "POST", "skills/org/roles-a/proposals/1/publish"), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(owner, "POST", "skills/org/roles-a/proposals/1/publish", { body: { agent: { id: "main" } } }), 403, "ORG_ACCESS_DENIED");
    expectStatus(await call(owner, "POST", "skills/org/roles-a/proposals/1/reject", { body: { reason: "no", agent: { id: "main" } } }), 403);

    // Project scope: the project's developers propose, its admin publishes.
    expectStatus(
      await call(projDev, "POST", "skills/proposals", { body: proposalBody({ scope: "project", project: projectA.slug, slug: "roles-p", submit: true }) }),
      201,
    );
    expectStatus(await call(projDev, "POST", `skills/${projectA.slug}/roles-p/proposals/1/publish`), 403);
    const published = expectStatus(await call(projAdmin, "POST", `skills/${projectA.slug}/roles-p/proposals/1/publish`), 200);
    expect(published.item).toMatchObject({ ref: `${projectA.slug}/roles-p`, version: 1 });
    expect(published.proposal).toMatchObject({ status: "published", publishedVersion: 1 });
  });

  test("a draft is visible to its author and the scope's reviewers; a proposal to every reader of the scope; hidden ones answer 404", async () => {
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "seen-a" }) }), 201);
    expectStatus(await call(dev, "GET", "skills/org/seen-a/proposals/1"), 200);
    expectStatus(await call(owner, "GET", "skills/org/seen-a/proposals/1"), 200);
    expectStatus(await call(dev2, "GET", "skills/org/seen-a/proposals/1"), 404, "NOT_FOUND");
    const listed = expectStatus(await call(dev2, "GET", "skills/org/seen-a/proposals"), 200);
    expect(listed.proposals).toHaveLength(0);
    expectStatus(await call(dev, "POST", "skills/org/seen-a/proposals/1/submit"), 200);
    expectStatus(await call(viewer, "GET", "skills/org/seen-a/proposals/1"), 200);

    expectStatus(
      await call(projDev, "POST", "skills/proposals", { body: proposalBody({ scope: "project", project: projectA.slug, slug: "seen-p", submit: true }) }),
      201,
    );
    expectStatus(await call(viewer, "GET", `skills/${projectA.slug}/seen-p/proposals/1`), 200);
    expectStatus(await call(outsider, "GET", `skills/${projectA.slug}/seen-p/proposals/1`), 404, "NOT_FOUND");
    const outsiderList = expectStatus(await call(outsider, "GET", "skills/proposals"), 200);
    expect(outsiderList.proposals.map((p: J) => p.ref)).not.toContain(`${projectA.slug}/seen-p`);
    const ownerList = expectStatus(await call(owner, "GET", "skills/proposals"), 200);
    expect(ownerList.proposals.map((p: J) => p.ref)).toEqual(expect.arrayContaining(["org/seen-a", `${projectA.slug}/seen-p`]));
  });

  test("published version numbers have no gaps; proposals carry their own proposalNumber", async () => {
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("numbers", "v1") }), 201);
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "numbers", body: "p1", submit: true }) }), 201);
    expectStatus(await call(dev2, "POST", "skills/proposals", { body: proposalBody({ slug: "numbers", body: "p2", submit: true }) }), 201);
    expectStatus(await call(owner, "POST", "skills/org/numbers/proposals/1/reject", { body: { reason: "Prefer the other one." } }), 200);
    const published = expectStatus(await call(owner, "POST", "skills/org/numbers/proposals/2/publish"), 200);
    expect(published.proposal).toMatchObject({ number: 2, publishedVersion: 2 });
    const versions = expectStatus(await call(viewer, "GET", "skills/org/numbers/versions"), 200);
    expect(versions.versions.map((v: J) => v.number)).toEqual([2, 1]);
    const shown = expectStatus(await call(viewer, "GET", "skills/org/numbers"), 200);
    expect(shown.version.files[0].content).toContain("p2");
  });

  test("a proposal for a new slug reserves it, stays out of search and show, and a deleted only draft removes the item", async () => {
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "brand-new", submit: true }) }), 201);
    expectStatus(await call(viewer, "GET", "skills/org/brand-new"), 404, "NOT_FOUND");
    const search = expectStatus(await call(viewer, "GET", "skills", { query: "q=brand" }), 200);
    expect(search.items.map((item: J) => item.slug)).not.toContain("brand-new");
    expectStatus(
      await call(projDev, "POST", "skills/proposals", { body: proposalBody({ scope: "project", project: projectA.slug, slug: "brand-new" }) }),
      409,
      "CONFLICT",
      "slug_taken_in_org",
    );
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "skills" }) }), 409, "CONFLICT", "slug_reserved");
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "proposals" }) }), 409, "CONFLICT", "slug_reserved");

    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "short-lived" }) }), 201);
    const withdrawn = expectStatus(await call(dev, "POST", "skills/org/short-lived/proposals/1/withdraw"), 200);
    expect(withdrawn).toMatchObject({ deleted: true, itemDeleted: true });
    expectStatus(await call(dev, "GET", "skills/org/short-lived/proposals"), 404);
    // The slug is free again, in any scope.
    expectStatus(
      await call(projDev, "POST", "skills/proposals", { body: proposalBody({ scope: "project", project: projectA.slug, slug: "short-lived" }) }),
      201,
    );

    // Withdrawing a submitted proposal keeps it in the history.
    const kept = expectStatus(await call(dev, "POST", "skills/org/brand-new/proposals/1/withdraw"), 200);
    expect(kept.proposal).toMatchObject({ status: "withdrawn" });
    expectStatus(await call(dev, "POST", "skills/org/brand-new/proposals/1/submit"), 409, "CONFLICT", "proposal_closed");
  });

  test("publishing a proposal whose base is not the current version is stale_base; content and metadata equal to the current version are unchanged", async () => {
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("stale", "v1") }), 201);
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "stale", body: "v1" }) }), 409, "CONFLICT", "unchanged");
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "stale", body: "change", baseVersion: 0 }) }), 409, "CONFLICT", "stale_base");
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "stale", body: "change", submit: true }) }), 201);
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("stale", "v2 by an admin") }), 201);

    const shown = expectStatus(await call(dev, "GET", "skills/org/stale/proposals/1"), 200);
    expect(shown.proposal).toMatchObject({ stale: true, baseVersion: 1, currentVersion: 2 });
    expect(shown.proposal.can.publish).toBe(false);
    const refused = expectStatus(await call(owner, "POST", "skills/org/stale/proposals/1/publish"), 409, "CONFLICT", "stale_base");
    expect(refused.details).toMatchObject({ currentVersion: 2, baseVersion: 1 });

    expectStatus(
      await call(dev, "POST", "skills/org/stale/proposals/1/update", { body: { description: "A skill", files: skillFiles("stale", "change on v2"), baseVersion: 1 } }),
      409,
      "CONFLICT",
      "stale_base",
    );
    const rebased = expectStatus(
      await call(dev, "POST", "skills/org/stale/proposals/1/update", { body: { description: "A skill", files: skillFiles("stale", "change on v2"), baseVersion: 2 } }),
      200,
    );
    expect(rebased.proposal).toMatchObject({ stale: false, baseVersion: 2, round: 2 });
    const published = expectStatus(await call(owner, "POST", "skills/org/stale/proposals/1/publish"), 200);
    expect(published.item.version).toBe(3);
  });

  test("updating a submitted proposal starts a new round; comments of earlier rounds are outdated", async () => {
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("rounds", "line one\nline two") }), 201);
    expectStatus(
      await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "rounds", body: "line one\nline 2", submit: true, agent: { id: "helper" } }) }),
      201,
    );
    const shown = expectStatus(await call(viewer, "GET", "skills/org/rounds/proposals/1"), 200);
    expect(shown.proposal.author).toMatchObject({ agentId: "helper", self: false });
    expect(shown.base.number).toBe(1);
    expect(shown.files.map((f: J) => f.path)).toEqual(["SKILL.md"]);

    const comment = expectStatus(
      await call(viewer, "POST", "skills/org/rounds/proposals/1/comments", { body: { body: "Say two in words.", path: "SKILL.md", line: 5 } }),
      201,
    );
    expect(comment.comment).toMatchObject({ path: "SKILL.md", line: 5, round: 1, outdated: false, can: { resolve: true } });
    expectStatus(
      await call(viewer, "POST", "skills/org/rounds/proposals/1/comments", { body: { body: "x", path: "nope.md", line: 1 } }),
      400,
      "PAYLOAD_INVALID",
    );
    expectStatus(await call(viewer, "POST", "skills/org/rounds/proposals/1/comments", { body: { body: "x", line: 1 } }), 400);
    const reply = expectStatus(
      await call(dev, "POST", "skills/org/rounds/proposals/1/comments", { body: { body: "Done in the next round.", parentId: comment.comment.id } }),
      201,
    );
    expect(reply.comment).toMatchObject({ parentId: comment.comment.id, path: null, line: null });
    const viewed = (await call(viewer, "GET", "skills/org/rounds/proposals/1")).body.proposal;
    expect(viewed.openComments).toBe(1);
    expect(viewed.reviewPath).toBe(`/${orgId}/library/org/rounds/proposals/1`);

    expectStatus(
      await call(dev, "POST", "skills/org/rounds/proposals/1/update", { body: { description: "A skill", files: skillFiles("rounds", "line one\nline two!") } }),
      200,
    );
    const after = expectStatus(await call(viewer, "GET", "skills/org/rounds/proposals/1"), 200);
    expect(after.proposal.round).toBe(2);
    expect(after.comments.find((c: J) => c.id === comment.comment.id)).toMatchObject({ round: 1, outdated: true });

    expectStatus(await call(dev2, "POST", `skills/org/rounds/proposals/1/comments/${comment.comment.id}/resolve`), 403);
    const resolved = expectStatus(await call(dev, "POST", `skills/org/rounds/proposals/1/comments/${comment.comment.id}/resolve`), 200);
    expect(resolved.comment.resolvedAt).not.toBeNull();
    expect(resolved.comment.resolvedBy).toMatchObject({ name: expect.any(String) });
    const reopened = expectStatus(await call(viewer, "POST", `skills/org/rounds/proposals/1/comments/${comment.comment.id}/reopen`), 200);
    expect(reopened.comment.resolvedAt).toBeNull();
  });

  test("submit, publish and reject of a proposal write one library inbox item each, without file contents", async () => {
    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "notify", body: "SECRET-BODY", note: "First cut" }) }), 201);
    expect((await inboxItems("library.skill.proposed")).filter((item) => item.payloadJson.ref === "org/notify")).toHaveLength(0);
    expectStatus(await call(dev, "POST", "skills/org/notify/proposals/1/submit"), 200);
    expectStatus(await call(dev, "POST", "skills/org/notify/proposals/1/submit"), 200); // idempotent
    const proposed = (await inboxItems("library.skill.proposed")).filter((item) => item.payloadJson.ref === "org/notify");
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({ category: "library", severity: "action_required", sensitivity: "metadata", targetType: "library_item" });
    expect(proposed[0]!.linksJson.reviewUrl).toBe(`https://console.test/${orgId}/library/org/notify/proposals/1`);
    expect(JSON.stringify(proposed[0])).not.toContain("SECRET-BODY");

    expectStatus(await call(owner, "POST", "skills/org/notify/proposals/1/publish"), 200);
    const published = (await inboxItems("library.skill.proposal_published")).filter((item) => item.payloadJson.ref === "org/notify");
    expect(published).toHaveLength(1);
    expect(published[0]!.payloadJson).toMatchObject({ proposalNumber: 1, version: 1 });

    expectStatus(await call(dev, "POST", "skills/proposals", { body: proposalBody({ slug: "notify", body: "second", submit: true }) }), 201);
    expectStatus(await call(owner, "POST", "skills/org/notify/proposals/2/reject", { body: { reason: "" } }), 400);
    expectStatus(await call(owner, "POST", "skills/org/notify/proposals/2/reject", { body: { reason: "Not needed." } }), 200);
    const rejected = (await inboxItems("library.skill.proposal_rejected")).filter((item) => item.payloadJson.ref === "org/notify");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.payloadJson).toMatchObject({ reason: "Not needed." });

    // A reviewer publishing their own draft is a direct publish: no inbox item.
    expectStatus(await call(owner, "POST", "skills/proposals", { body: proposalBody({ slug: "notify", body: "third" }) }), 201);
    expectStatus(await call(owner, "POST", "skills/org/notify/proposals/3/publish"), 200);
    expect((await inboxItems("library.skill.proposal_published")).filter((item) => item.payloadJson.ref === "org/notify")).toHaveLength(1);
  });

  test("reviewers revert to an older version as a new version", async () => {
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("revert-me", "first") }), 201);
    expectStatus(await call(owner, "POST", "skills", { body: publishBody("revert-me", "second") }), 201);
    expectStatus(await call(dev, "POST", "skills/org/revert-me/versions/1/revert"), 403);
    expectStatus(await call(owner, "POST", "skills/org/revert-me/versions/2/revert"), 409, "CONFLICT", "unchanged");
    expectStatus(await call(owner, "POST", "skills/org/revert-me/versions/9/revert"), 404);
    const reverted = expectStatus(await call(owner, "POST", "skills/org/revert-me/versions/1/revert"), 201);
    expect(reverted).toMatchObject({ version: { number: 3 }, revertedTo: 1 });
    const shown = expectStatus(await call(viewer, "GET", "skills/org/revert-me"), 200);
    expect(shown.version).toMatchObject({ number: 3, note: "Reverted to version 1." });
    expect(shown.version.files[0].content).toContain("first");
  });
});

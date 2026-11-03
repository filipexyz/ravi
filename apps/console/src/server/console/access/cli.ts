import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { CliAuthContext } from "@/server/cli/auth";
import { type CliApiError, cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { raviLinkRepositoryForDb } from "@/server/console/ravi-link";
import { db, schema } from "@/server/db";
import { type AccessActor, memberActorForOrganization } from "./common";
import { assertCanShareSite, listPagesSiteAccess, sharePagesAccess, unsharePagesAccess } from "./grants";
import {
  assertCanInvite,
  INVITE_ROLES,
  createOrganizationInvite,
  listOrganizationInvites,
  revokeOrganizationInvite,
} from "./invites";
import { createAccessRequest, getAccessRequestForCli } from "./requests";
import { resolvePageTarget } from "./targets";

/**
 * `/api/cli/access/...`: agents share pages, invite people and ask for access
 * through a `ravi login` session (see the console/access spec, CLI Contract).
 *
 * Who acts: without `actor`, the CLI session user. With
 * `actor: { contactId }`, the Console user bound to that chat contact on this
 * installation by `ravi link`, never what the daemon says about who they are.
 * Writes in the session's organization then need both the session user and
 * that person to pass the role check, so an agent never does more than its
 * operator could.
 */

export type AccessCliRequest = {
  auth: CliAuthContext;
  body: unknown;
  method: "GET" | "POST";
  origin: string;
  requestId: string;
  segments: string[];
};

export type AccessCliResult = { payload: unknown; status: number };

const actorSchema = z
  .object({ contactId: z.string().trim().min(1).max(256) })
  .strict()
  .optional()
  .nullable();

const urlSchema = z.string().trim().min(1).max(4096);

const shareSchema = z.object({
  actor: actorSchema,
  email: z.string().trim().toLowerCase().email().max(320),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
  reason: z.string().trim().max(500).optional().nullable(),
  site: z.boolean().optional().default(false),
  url: urlSchema,
});

const unshareSchema = z.union([
  z.object({ actor: actorSchema, grantId: z.string().uuid() }),
  z.object({
    actor: actorSchema,
    email: z.string().trim().toLowerCase().email().max(320),
    site: z.boolean().optional().default(false),
    url: urlSchema,
  }),
]);

const listAccessSchema = z.object({ actor: actorSchema, url: urlSchema });

const inviteSchema = z.object({
  actor: actorSchema,
  email: z.string().trim().toLowerCase().email().max(320),
  reason: z.string().trim().max(500).optional().nullable(),
  role: z.enum(INVITE_ROLES).optional(),
});

const revokeInviteSchema = z.object({ actor: actorSchema, inviteId: z.string().uuid() });

const requestSchema = z.object({
  actor: actorSchema,
  agent: z
    .object({ id: z.string().trim().min(1).max(128), name: z.string().trim().max(128).optional().nullable() })
    .optional()
    .nullable(),
  message: z.string().trim().max(500).optional().nullable(),
  url: urlSchema,
});

export async function handleAccessCliRequest(input: AccessCliRequest): Promise<AccessCliResult> {
  const { auth, method, segments } = input;
  const route = `${method} ${segments.join("/")}`;
  try {
    if (route === "POST pages/share") {
      requireScopes(auth, ["console.projects.read", "artifacts.publish"]);
      const body = parse(shareSchema, input.body);
      const { session, acting } = await actorsFor(auth, body.actor);
      const target = await resolvePageTarget(body.url);
      await assertBothCanShare(session, acting, target.site);
      if (!body.site && !target.route) throw new ConsoleApiError(404, { error: "route_not_found" });
      const result = await sharePagesAccess({
        actor: acting,
        body: {
          email: body.email,
          expiresAt: body.expiresAt ?? null,
          reason: body.reason ?? null,
          siteId: target.site.id,
          ...(body.site ? {} : { routeId: target.route!.routeId }),
        },
        requestId: input.requestId,
      });
      return { payload: result, status: result.created ? 201 : 200 };
    }

    if (route === "POST pages/unshare") {
      requireScopes(auth, ["console.projects.read", "artifacts.publish"]);
      const body = parse(unshareSchema, input.body);
      const { session, acting } = await actorsFor(auth, body.actor);
      let grantId: string;
      if ("grantId" in body) {
        const site = await siteOfGrant(body.grantId, session.organizationId);
        if (!site) throw new ConsoleApiError(404, { error: "grant_not_found" });
        await assertBothCanShare(session, acting, site);
        grantId = body.grantId;
      } else {
        const target = await resolvePageTarget(body.url);
        await assertBothCanShare(session, acting, target.site);
        if (!body.site && !target.route) throw new ConsoleApiError(404, { error: "route_not_found" });
        const found = await findGrantFor({
          email: body.email,
          objectId: body.site ? target.site.id : target.route!.routeId,
          objectType: body.site ? "page_site" : "page_route",
        });
        if (!found) throw new ConsoleApiError(404, { error: "grant_not_found" });
        grantId = found;
      }
      return {
        payload: await unsharePagesAccess({ actor: acting, body: { grantId }, requestId: input.requestId }),
        status: 200,
      };
    }

    if (route === "POST pages/access") {
      requireScopes(auth, ["console.projects.read"]);
      const body = parse(listAccessSchema, input.body);
      const { session, acting } = await actorsFor(auth, body.actor);
      const target = await resolvePageTarget(body.url);
      await assertBothCanShare(session, acting, target.site);
      const { grants } = await listPagesSiteAccess({ actor: acting, siteId: target.site.id });
      const scoped = target.route
        ? grants.filter((grant) => grant.scope === "site" || grant.routeId === target.route!.routeId)
        : grants;
      return {
        payload: { grants: scoped, site: { host: target.site.defaultHostname, id: target.site.id } },
        status: 200,
      };
    }

    if (route === "POST invites/create") {
      requireScopes(auth, ["console.projects.read"]);
      const body = parse(inviteSchema, input.body);
      const { session, acting } = await actorsFor(auth, body.actor);
      const role = body.role ?? "viewer";
      assertCanInvite(session, role);
      const result = await createOrganizationInvite({
        actor: acting,
        body: { email: body.email, reason: body.reason ?? null, role },
        origin: input.origin,
        requestId: input.requestId,
      });
      return { payload: result, status: 201 };
    }

    if (route === "GET invites") {
      requireScopes(auth, ["console.projects.read"]);
      const session = sessionActor(auth);
      return { payload: { invites: await listOrganizationInvites({ actor: session }) }, status: 200 };
    }

    if (route === "POST invites/revoke") {
      requireScopes(auth, ["console.projects.read"]);
      const body = parse(revokeInviteSchema, input.body);
      const { session, acting } = await actorsFor(auth, body.actor);
      assertCanInvite(session, "viewer");
      return {
        payload: await revokeOrganizationInvite({
          actor: acting,
          alsoAuthorize: [session],
          body: { inviteId: body.inviteId },
          requestId: input.requestId,
        }),
        status: 200,
      };
    }

    if (route === "POST requests/create") {
      requireScopes(auth, ["console.projects.read"]);
      const body = parse(requestSchema, input.body);
      const { acting } = await actorsFor(auth, body.actor, { allowNonMember: true });
      const result = await createAccessRequest({
        caller: {
          cli: {
            agentId: body.agent?.id ?? null,
            agentName: body.agent?.name ?? null,
            installationId: auth.localInstallation.id,
            organizationId: auth.organization.id,
          },
          userId: acting.userId,
        },
        message: body.message ?? null,
        origin: input.origin,
        requestId: input.requestId,
        url: body.url,
      });
      if (result.status === "already_allowed") return { payload: result, status: 200 };
      return { payload: { request: result.request }, status: result.created ? 201 : 200 };
    }

    if (method === "GET" && segments[0] === "requests" && segments.length === 2) {
      requireScopes(auth, ["console.projects.read"]);
      return {
        payload: await getAccessRequestForCli({
          id: segments[1]!,
          installationId: auth.localInstallation.id,
          origin: input.origin,
          userIds: [auth.user.id],
        }),
        status: 200,
      };
    }

    throw cliApiError(404, "NOT_FOUND", "Unknown access route.");
  } catch (error) {
    throw mapAccessError(error);
  }
}

function sessionActor(auth: CliAuthContext): AccessActor {
  return {
    actorType: "cli",
    organizationId: auth.organization.id,
    role: auth.membership.role,
    userId: auth.user.id,
    via: { channel: "cli", installationId: auth.localInstallation.id },
  };
}

/**
 * The session actor and the person acting. They are the same object when no
 * contact is named, so callers can tell the two cases apart by identity.
 */
async function actorsFor(
  auth: CliAuthContext,
  actor: { contactId: string } | null | undefined,
  options: { allowNonMember?: boolean } = {},
): Promise<{ acting: AccessActor; session: AccessActor }> {
  const session = sessionActor(auth);
  if (!actor) return { acting: session, session };

  const binding = await raviLinkRepositoryForDb().findActiveBindingByContact(auth.localInstallation.id, actor.contactId);
  if (!binding) {
    throw cliApiError(
      403,
      "ACTOR_NOT_LINKED",
      "This person has not linked their Ravi account here yet. Send them `ravi link` and try again after they approve it.",
    );
  }
  const via = {
    bindingId: binding.id,
    channel: "cli",
    cliUserId: auth.user.id,
    contactId: actor.contactId,
    installationId: auth.localInstallation.id,
  };
  if (binding.consoleUserId === auth.user.id) return { acting: { ...session, via }, session };

  const member = await memberActorForOrganization({ organizationId: auth.organization.id, userId: binding.consoleUserId, via });
  if (member) return { acting: { ...member, actorType: "cli" }, session };
  if (options.allowNonMember) {
    return {
      acting: { actorType: "cli", organizationId: auth.organization.id, role: "none", userId: binding.consoleUserId, via },
      session,
    };
  }
  throw cliApiError(403, "PROJECT_ACCESS_DENIED", "The person asking is not a member of this organization.");
}

async function assertBothCanShare(
  session: AccessActor,
  acting: AccessActor,
  site: { organizationId: string; projectId: string },
) {
  if (site.organizationId !== session.organizationId) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", "This Ravi Page belongs to another organization than this CLI session.");
  }
  await assertCanShareSite(session, site);
  if (acting !== session) await assertCanShareSite(acting, site);
}

async function siteOfGrant(grantId: string, organizationId: string) {
  const [row] = await db
    .select({ organizationId: schema.pageSites.organizationId, projectId: schema.pageSites.projectId })
    .from(schema.accessGrants)
    .innerJoin(schema.pageSites, eq(schema.pageSites.id, schema.accessGrants.pageSiteId))
    .where(and(eq(schema.accessGrants.id, grantId), eq(schema.accessGrants.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

async function findGrantFor(input: { email: string; objectId: string; objectType: "page_route" | "page_site" }) {
  const [row] = await db
    .select({ id: schema.accessGrants.id })
    .from(schema.accessGrants)
    .innerJoin(schema.users, eq(schema.users.id, schema.accessGrants.subjectId))
    .where(
      and(
        eq(schema.accessGrants.objectType, input.objectType),
        eq(schema.accessGrants.objectId, input.objectId),
        eq(schema.accessGrants.relation, "viewer"),
        eq(schema.accessGrants.subjectType, "user"),
        isNull(schema.accessGrants.revokedAt),
        eq(schema.users.primaryEmail, input.email),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function requireScopes(auth: CliAuthContext, scopes: string[]) {
  for (const scope of scopes) {
    if (!auth.scopes.includes(scope)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Run \`ravi login\` again.`);
    }
  }
}

function parse<T extends z.ZodTypeAny>(schemaToUse: T, body: unknown): z.infer<T> {
  const result = schemaToUse.safeParse(body ?? {});
  if (!result.success) {
    const fields = Object.keys(result.error.flatten().fieldErrors);
    throw cliApiError(400, "PAYLOAD_INVALID", fields.length ? `Check ${fields.join(", ")}.` : "Check the request body.", {
      fields,
    });
  }
  return result.data;
}

function mapAccessError(error: unknown): unknown {
  if (!(error instanceof ConsoleApiError)) return error;
  const code = error.payload.error;
  const fieldErrors = (error.payload.fieldErrors ?? {}) as Record<string, string>;
  const fail = (status: number, cliCode: Parameters<typeof cliApiError>[1], message: string): CliApiError =>
    cliApiError(status, cliCode, message, Object.keys(fieldErrors).length ? { fieldErrors, reason: code } : { reason: code });
  switch (code) {
    case "validation_failed":
      return fail(400, "PAYLOAD_INVALID", Object.values(fieldErrors)[0] ?? "Check the request.");
    case "invalid_url":
      return fail(400, "PAYLOAD_INVALID", "Pass a Ravi Page URL such as https://acme.ravi.page/weekly.");
    case "password_route":
      return fail(400, "PAYLOAD_INVALID", "This page is protected by a password; access to it can't be given per person.");
    case "site_not_found":
      return fail(404, "NOT_FOUND", "No Ravi Pages site answers at this URL.");
    case "route_not_found":
      return fail(404, "NOT_FOUND", "No published page matches this path. Pass --site to share the whole site.");
    case "grant_not_found":
      return fail(404, "NOT_FOUND", "That person has no access to remove here.");
    case "invite_not_found":
      return fail(404, "NOT_FOUND", "No pending invite with that id.");
    case "request_not_found":
      return fail(404, "NOT_FOUND", "No access request with that id for this installation.");
    case "forbidden":
      return fail(403, "PROJECT_ACCESS_DENIED", "The person asking can't do this in this project or organization.");
    case "owner_required":
      return fail(403, "PROJECT_ACCESS_DENIED", "Only an owner can invite another owner.");
    case "already_member":
      return fail(409, "CONFLICT", "That email already belongs to an active member of this organization.");
    case "user_inactive":
      return fail(409, "CONFLICT", "That account is disabled.");
    case "rate_limited":
      return fail(429, "RATE_LIMITED", "Too many access requests today. Try again tomorrow.");
    default:
      return fail(error.status >= 500 ? 503 : error.status, error.status >= 500 ? "SERVER_UNAVAILABLE" : "PAYLOAD_INVALID", "The request could not be completed.");
  }
}

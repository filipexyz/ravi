// Meetings across organizations: one person given access to one meeting by
// email (a `meeting#viewer@user` tuple in `access_grants`), and the policy that
// lets agents logged into another organization read a meeting at the moment.
//
// The meeting never changes owner and is never copied: every read goes back
// to its organization, which checks access each time and audits the reads
// that come from elsewhere.

import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";

import { cliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  type AccessActor,
  displayNameFor,
  findOrCreateUserByEmail,
  memberActorForOrganization,
  zodFieldErrors,
} from "@/server/console/access/common";
import { ACCESS_GRANT_MAX_DAYS } from "@/server/console/access/grants";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { canAccessProject } from "@/server/console/project-access";
import { db, schema } from "@/server/db";
import type { JsonRecord } from "@/server/db/schema";

import { MEETINGS_FEATURE_KEY } from "./limits";
import {
  getMeetingRecordingForRow,
  loadProjectMeeting,
  openMeetingMediaForRow,
  serializeMeetingBot,
  type MeetingsDeps,
  type MeetingsWorkspace,
} from "./service";
import type { MeetingBotRow } from "./store";

type GrantRecord = typeof schema.accessGrants.$inferSelect;
type UserRecord = typeof schema.users.$inferSelect;

/** Off by default: agents logged into another organization cannot read this organization's meetings. */
export const MEETINGS_EXTERNAL_AGENTS_POLICY = "meetings.external_agents";
const POLICY_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const SOURCE = "console.meetings.sharing";

export const SHARED_MEETING_PATH = "/shared/meetings";

export function sharedMeetingPath(meetingId: string) {
  return `${SHARED_MEETING_PATH}/${meetingId}`;
}

const uuidSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Organization policy
// ---------------------------------------------------------------------------

export type MeetingsSharingSettings = {
  /** Agents logged into other organizations may read this organization's meetings for people who can see them. */
  externalAgents: boolean;
  /** Whether the viewer may change it (owner or admin). */
  canEdit: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

async function readPolicyRow(organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.organizationPolicies)
    .where(
      and(
        eq(schema.organizationPolicies.organizationId, organizationId),
        eq(schema.organizationPolicies.key, MEETINGS_EXTERNAL_AGENTS_POLICY),
      ),
    )
    .limit(1);
  return row ?? null;
}

function policyEnabled(row: { valueJson: JsonRecord } | null) {
  return row?.valueJson?.enabled === true;
}

export async function meetingsExternalAgentsAllowed(organizationId: string) {
  return policyEnabled(await readPolicyRow(organizationId));
}

export async function getMeetingsSharingSettings(workspace: MeetingsWorkspace): Promise<MeetingsSharingSettings> {
  const row = await readPolicyRow(workspace.organization.id);
  const updater = row?.updatedByUserId ? await findUser(row.updatedByUserId) : null;
  return {
    externalAgents: policyEnabled(row),
    canEdit: POLICY_ROLES.has(workspace.membership.role),
    updatedAt: row ? row.updatedAt.toISOString() : null,
    updatedBy: displayNameFor(updater),
  };
}

const settingsBodySchema = z.object({ externalAgents: z.boolean() }).strict();

export async function updateMeetingsSharingSettings(input: {
  body: unknown;
  requestId: string;
  workspace: MeetingsWorkspace;
}): Promise<MeetingsSharingSettings> {
  if (!POLICY_ROLES.has(input.workspace.membership.role)) {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }
  const parsed = settingsBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { externalAgents: "Choose on or off." },
    });
  }
  const organizationId = input.workspace.organization.id;
  const enabled = parsed.data.externalAgents;
  const now = new Date();

  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(schema.organizationPolicies)
      .where(
        and(
          eq(schema.organizationPolicies.organizationId, organizationId),
          eq(schema.organizationPolicies.key, MEETINGS_EXTERNAL_AGENTS_POLICY),
        ),
      )
      .limit(1);
    if (policyEnabled(before ?? null) === enabled) return;
    await tx
      .insert(schema.organizationPolicies)
      .values({
        organizationId,
        key: MEETINGS_EXTERNAL_AGENTS_POLICY,
        valueJson: { enabled },
        updatedByUserId: input.workspace.user.id,
      })
      .onConflictDoUpdate({
        target: [schema.organizationPolicies.organizationId, schema.organizationPolicies.key],
        set: { valueJson: { enabled }, updatedByUserId: input.workspace.user.id, updatedAt: now },
      });
    await tx.insert(schema.auditEvents).values({
      action: "organization_policy.updated",
      actorId: input.workspace.user.id,
      actorType: "user",
      afterJson: { key: MEETINGS_EXTERNAL_AGENTS_POLICY, enabled },
      beforeJson: { key: MEETINGS_EXTERNAL_AGENTS_POLICY, enabled: policyEnabled(before ?? null) },
      metadataJson: { source: SOURCE },
      organizationId,
      requestId: input.requestId,
      targetId: organizationId,
      targetType: "organization",
    });
  });

  return getMeetingsSharingSettings(input.workspace);
}

// ---------------------------------------------------------------------------
// Who may see a meeting
// ---------------------------------------------------------------------------

export type MeetingAccessKind = "member" | "guest";

export type ResolvedMeeting = {
  row: MeetingBotRow;
  organization: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string } | null;
  access: MeetingAccessKind;
};

/** Whether this person was given this meeting. Grants never come from membership; that check is separate. */
export async function canUserViewMeeting(input: { meetingBotId: string; now?: Date; userId: string }) {
  const now = input.now ?? new Date();
  const [row] = await db
    .select({ id: schema.accessGrants.id })
    .from(schema.accessGrants)
    .innerJoin(schema.users, eq(schema.users.id, schema.accessGrants.subjectId))
    .where(
      and(
        eq(schema.accessGrants.meetingBotId, input.meetingBotId),
        eq(schema.accessGrants.objectType, "meeting"),
        eq(schema.accessGrants.objectId, input.meetingBotId),
        eq(schema.accessGrants.relation, "viewer"),
        eq(schema.accessGrants.subjectType, "user"),
        eq(schema.accessGrants.subjectId, input.userId),
        isNull(schema.accessGrants.revokedAt),
        or(isNull(schema.accessGrants.expiresAt), gt(schema.accessGrants.expiresAt, now)),
        eq(schema.users.status, "active"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export type ResolveMeetingDeps = {
  findMeeting?: (meetingId: string) => Promise<{
    row: MeetingBotRow;
    organization: ResolvedMeeting["organization"] & { status: string };
    project: ResolvedMeeting["project"];
  } | null>;
  memberRole?: (input: { organizationId: string; userId: string }) => Promise<string | null>;
  canReadProject?: (input: { organizationId: string; projectId: string; role: string; userId: string }) => Promise<boolean>;
  featureFor?: (input: { organizationId: string; role: string }) => Promise<{ available: boolean; authorized: boolean }>;
  hasGrant?: (input: { meetingBotId: string; userId: string }) => Promise<boolean>;
};

/**
 * The meeting as this person may see it, from wherever they are signed in:
 * as a member of its organization who can read its project, or through a
 * grant on the meeting. Anything else is `404`, so the meeting's existence
 * does not leak.
 */
export async function resolveMeetingForUser(
  input: { meetingId: string; userId: string },
  deps: ResolveMeetingDeps = {},
): Promise<ResolvedMeeting> {
  const notFound = () => cliApiError(404, "NOT_FOUND", "Meeting not found, or not shared with you.");
  if (!uuidSchema.safeParse(input.meetingId).success) throw notFound();
  const found = await (deps.findMeeting ?? findMeetingWithOwner)(input.meetingId);
  if (!found || found.organization.status !== "active" || !found.row.projectId) throw notFound();
  const { row, project } = found;
  const organization = { id: found.organization.id, slug: found.organization.slug, name: found.organization.name };
  const projectId = found.row.projectId;
  const featureFor = deps.featureFor ?? featureForRole;

  const role = await (deps.memberRole ?? memberRole)({ organizationId: row.organizationId, userId: input.userId });
  if (role) {
    const feature = await featureFor({ organizationId: row.organizationId, role });
    const canRead =
      feature.available &&
      feature.authorized &&
      (await (deps.canReadProject ?? canReadProject)({
        organizationId: row.organizationId,
        projectId,
        role,
        userId: input.userId,
      }));
    if (canRead) return { row, organization, project, access: "member" };
  }

  if (await (deps.hasGrant ?? canUserViewMeeting)({ meetingBotId: row.id, userId: input.userId })) {
    // The organization may have lost meetings since; a grant does not outlive the feature.
    const feature = await featureFor({ organizationId: row.organizationId, role: "owner" });
    if (feature.available) return { row, organization, project, access: "guest" };
  }
  throw notFound();
}

async function findMeetingWithOwner(meetingId: string) {
  const [found] = await db
    .select({ row: schema.meetingBots, organization: schema.organizations })
    .from(schema.meetingBots)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.meetingBots.organizationId))
    .where(eq(schema.meetingBots.id, meetingId))
    .limit(1);
  if (!found) return null;
  let project: ResolvedMeeting["project"] = null;
  if (found.row.projectId) {
    const [row] = await db
      .select({ id: schema.projects.id, slug: schema.projects.slug, name: schema.projects.name })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, found.row.projectId), eq(schema.projects.organizationId, found.row.organizationId)))
      .limit(1);
    project = row ?? null;
  }
  return {
    row: found.row,
    organization: {
      id: found.organization.id,
      slug: found.organization.slug,
      name: found.organization.name,
      status: found.organization.status,
    },
    project,
  };
}

async function memberRole(input: { organizationId: string; userId: string }) {
  return (await memberActorForOrganization(input))?.role ?? null;
}

async function canReadProject(input: { organizationId: string; projectId: string; role: string; userId: string }) {
  return canAccessProject(
    { membership: { role: input.role }, organization: { id: input.organizationId }, user: { id: input.userId } },
    input.projectId,
    "read",
  );
}

async function featureForRole(input: { organizationId: string; role: string }) {
  const access = await getConsoleFeatureAccessForOrganizationRole(input);
  const feature = access.byKey[MEETINGS_FEATURE_KEY];
  return { available: feature.available, authorized: feature.authorized };
}

// ---------------------------------------------------------------------------
// Reading from another organization's agent
// ---------------------------------------------------------------------------

const readBodySchema = z
  .object({
    url: z.string().trim().min(1).max(2048).optional(),
    meetingId: z.string().trim().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.url) !== Boolean(value.meetingId), { message: "Pass a url or a meetingId." });

const MEETING_PATH_RE = /\/meetings\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * The meeting id in a Console meeting link: `/p/<project>/meetings/<id>`,
 * `/<org>/p/<project>/meetings/<id>` or `/shared/meetings/<id>`, on any host.
 */
export function meetingIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const match = MEETING_PATH_RE.exec(url.pathname);
  return match?.[1]?.toLowerCase() ?? null;
}

export function parseMeetingReadBody(body: unknown) {
  const parsed = readBodySchema.safeParse(body);
  if (!parsed.success) throw cliApiError(400, "PAYLOAD_INVALID", "Pass a Console meeting link (url) or a meeting id (meetingId).");
  const meetingId = parsed.data.meetingId ?? meetingIdFromUrl(parsed.data.url ?? "");
  if (!meetingId || !uuidSchema.safeParse(meetingId).success) {
    throw cliApiError(400, "PAYLOAD_INVALID", "That is not a Console meeting link or id.");
  }
  return { meetingId: meetingId.toLowerCase() };
}

export type ExternalReadDeps = ResolveMeetingDeps & {
  externalAgentsAllowed?: (organizationId: string) => Promise<boolean>;
  audit?: (input: {
    organizationId: string;
    projectId: string | null;
    meetingBotId: string;
    userId: string;
    requestId: string;
    afterJson: JsonRecord;
  }) => Promise<void>;
};

/**
 * Checks a CLI session's read of a meeting by link or id. Inside its own
 * organization this is the usual project read. From another organization the
 * person must still pass the meeting organization's own check (membership or
 * a grant), that organization must allow agents from other organizations, and
 * the read is audited there.
 */
export async function authorizeMeetingReadFromCli(
  input: {
    body: unknown;
    requestId: string;
    session: { organizationId: string; userId: string; localInstallationId: string | null };
  },
  deps: ExternalReadDeps = {},
): Promise<ResolvedMeeting & { crossOrganization: boolean }> {
  const { meetingId } = parseMeetingReadBody(input.body);
  const resolved = await resolveMeetingForUser({ meetingId, userId: input.session.userId }, deps);
  const crossOrganization = resolved.row.organizationId !== input.session.organizationId;
  if (!crossOrganization) return { ...resolved, crossOrganization };

  const allowed = await (deps.externalAgentsAllowed ?? meetingsExternalAgentsAllowed)(resolved.row.organizationId);
  const afterJson: JsonRecord = {
    access: resolved.access,
    allowed,
    fromOrganizationId: input.session.organizationId,
    localInstallationId: input.session.localInstallationId,
  };
  await (deps.audit ?? auditExternalRead)({
    organizationId: resolved.row.organizationId,
    projectId: resolved.row.projectId,
    meetingBotId: resolved.row.id,
    userId: input.session.userId,
    requestId: input.requestId,
    afterJson,
  });
  if (!allowed) {
    throw cliApiError(
      403,
      "ORG_ACCESS_DENIED",
      `${resolved.organization.name} does not let agents from other organizations read its meetings. An owner or admin of ${resolved.organization.name} can allow it in that organization's settings.`,
      { reason: "external_agents_disabled", organization: { name: resolved.organization.name } },
    );
  }
  return { ...resolved, crossOrganization };
}

async function auditExternalRead(input: {
  organizationId: string;
  projectId: string | null;
  meetingBotId: string;
  userId: string;
  requestId: string;
  afterJson: JsonRecord;
}) {
  await db.insert(schema.auditEvents).values({
    action: input.afterJson.allowed ? "meetings.read.external" : "meetings.read.external_denied",
    actorId: input.userId,
    actorType: "user",
    afterJson: input.afterJson,
    metadataJson: { source: SOURCE },
    organizationId: input.organizationId,
    projectId: input.projectId,
    requestId: input.requestId,
    targetId: input.meetingBotId,
    targetType: "meeting_bot",
  });
}

/**
 * The meeting as the reader may see it. Only a member reading from inside the
 * meeting's organization gets the call link and the client reference: a guest
 * or another organization's agent gets the recording, never a way into the
 * room's later calls.
 */
export function resolvedMeetingView(resolved: ResolvedMeeting, options: { crossOrganization?: boolean } = {}) {
  const meeting = serializeMeetingBot(resolved.row);
  const full = resolved.access === "member" && !options.crossOrganization;
  return {
    meeting: full ? meeting : { ...meeting, meetingUrl: "", clientRef: null },
    organization: resolved.organization,
    project: resolved.project,
    access: resolved.access,
  };
}

// ---------------------------------------------------------------------------
// The Console page for a meeting shared with someone
// ---------------------------------------------------------------------------

export const SHARED_MEETING_API_PATH = "/api/console/shared/meetings";

/**
 * A meeting's recording for the signed-in person at `/shared/meetings/<id>`,
 * outside any organization workspace: members of its organization who can
 * read it and people it was shared with. Media paths stay under this route.
 * Views through a grant are audited in the meeting's organization.
 */
export async function readSharedMeeting(
  input: { meetingId: string; requestId: string; userId: string },
  deps: MeetingsDeps & ResolveMeetingDeps = {},
) {
  const resolved = await resolveMeetingForUser(input, deps);
  if (resolved.access === "guest" && !(await guestViewAuditedRecently(resolved.row, input.userId))) {
    await db.insert(schema.auditEvents).values({
      action: "meetings.read.guest",
      actorId: input.userId,
      actorType: "user",
      afterJson: { access: "guest" },
      metadataJson: { source: SOURCE },
      organizationId: resolved.row.organizationId,
      projectId: resolved.row.projectId,
      requestId: input.requestId,
      targetId: resolved.row.id,
      targetType: "meeting_bot",
    });
  }
  const view = resolvedMeetingView(resolved);
  if (resolved.row.status !== "done") return { ...view, recording: null };
  const { meeting: _meeting, ...recording } = await getMeetingRecordingForRow(
    resolved.row,
    `${SHARED_MEETING_API_PATH}/${resolved.row.id}/media`,
    deps,
  );
  return { ...view, recording };
}

/** The page refreshes while a call is processing: one audit row per person and meeting every 30 minutes. */
const GUEST_VIEW_AUDIT_WINDOW_MS = 30 * 60_000;

async function guestViewAuditedRecently(row: MeetingBotRow, userId: string) {
  const [recent] = await db
    .select({ id: schema.auditEvents.id })
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.organizationId, row.organizationId),
        eq(schema.auditEvents.action, "meetings.read.guest"),
        eq(schema.auditEvents.actorId, userId),
        eq(schema.auditEvents.targetId, row.id),
        gt(schema.auditEvents.createdAt, new Date(Date.now() - GUEST_VIEW_AUDIT_WINDOW_MS)),
      ),
    )
    .limit(1);
  return Boolean(recent);
}

export async function openSharedMeetingMedia(
  input: {
    meetingId: string;
    userId: string;
    kind: string;
    part: number;
    range?: string | null;
    disposition?: "attachment" | "inline";
  },
  deps: MeetingsDeps & ResolveMeetingDeps & { fetchImpl?: typeof fetch } = {},
) {
  const resolved = await resolveMeetingForUser(input, deps);
  return openMeetingMediaForRow(resolved.row, input, deps);
}

// ---------------------------------------------------------------------------
// Giving one person access to one meeting
// ---------------------------------------------------------------------------

export type MeetingGrantSummary = {
  id: string;
  email: string;
  name: string | null;
  userId: string;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
  /** Console path of the meeting for the person given access. */
  path: string;
};

export type SharedMeetingSummary = {
  grantId: string;
  meetingId: string;
  title: string | null;
  organizationName: string;
  sharedBy: string | null;
  sharedAt: string;
  expiresAt: string | null;
  recordedAt: string | null;
  path: string;
};

const shareBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    expiresAt: z.string().datetime({ offset: true }).optional().nullable(),
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

const unshareBodySchema = z.object({ grantId: z.string().uuid() }).strict();

function parseShareBody(body: unknown, now: Date) {
  const result = shareBodySchema.safeParse(body);
  if (!result.success) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: zodFieldErrors(result.error, {
        email: "Enter a valid email.",
        expiresAt: "Pick a valid date.",
        reason: "Keep the note under 500 characters.",
      }),
    });
  }
  const expiresAt = result.data.expiresAt ? new Date(result.data.expiresAt) : null;
  if (expiresAt) {
    const max = now.getTime() + ACCESS_GRANT_MAX_DAYS * 24 * 60 * 60 * 1000;
    if (expiresAt.getTime() <= now.getTime() || expiresAt.getTime() > max) {
      throw new ConsoleApiError(400, {
        error: "validation_failed",
        fieldErrors: { expiresAt: `Pick a date in the next ${ACCESS_GRANT_MAX_DAYS} days.` },
      });
    }
  }
  return { email: result.data.email, expiresAt, reason: result.data.reason || null };
}

/** Gives one person, by email, read access to one meeting. Idempotent: sharing again updates expiry and note. */
export async function shareMeeting(
  input: {
    body: unknown;
    meetingId: string;
    now?: Date;
    projectRef: string;
    requestId: string;
    workspace: MeetingsWorkspace;
  },
  deps: MeetingsDeps = {},
): Promise<{ created: boolean; grant: MeetingGrantSummary; userCreated: boolean }> {
  const now = input.now ?? new Date();
  const body = parseShareBody(input.body, now);
  const row = await loadProjectMeeting(input, "write", deps);
  if (!row.projectId) throw cliApiError(404, "NOT_FOUND", "Meeting not found.");
  const projectId = row.projectId;
  const actor: AccessActor = {
    actorType: "user",
    organizationId: input.workspace.organization.id,
    role: input.workspace.membership.role,
    userId: input.workspace.user.id,
  };

  const result = await db.transaction(async (tx) => {
    const { created: userCreated, user } = await findOrCreateUserByEmail(tx, {
      actor,
      createdFrom: "console_meetings_share",
      email: body.email,
      requestId: input.requestId,
    });
    if (user.status !== "active") throw new ConsoleApiError(409, { error: "user_inactive" });

    const activeGrant = () =>
      tx
        .select()
        .from(schema.accessGrants)
        .where(
          and(
            eq(schema.accessGrants.objectType, "meeting"),
            eq(schema.accessGrants.objectId, row.id),
            eq(schema.accessGrants.relation, "viewer"),
            eq(schema.accessGrants.subjectType, "user"),
            eq(schema.accessGrants.subjectId, user.id),
            isNull(schema.accessGrants.revokedAt),
          ),
        )
        .limit(1);
    const [existing] = await activeGrant();

    if (existing) {
      const [updated] = await tx
        .update(schema.accessGrants)
        .set({ expiresAt: body.expiresAt, reason: body.reason, updatedAt: now })
        .where(eq(schema.accessGrants.id, existing.id))
        .returning();
      const grant = updated ?? existing;
      await tx.insert(schema.auditEvents).values({
        action: "access_grant.updated",
        actorId: actor.userId,
        actorType: actor.actorType,
        afterJson: { grant: sanitizeGrant(grant) },
        beforeJson: { grant: sanitizeGrant(existing) },
        metadataJson: { source: SOURCE },
        organizationId: row.organizationId,
        projectId,
        requestId: input.requestId,
        targetId: grant.id,
        targetType: "access_grant",
      });
      return { created: false, grant, user, userCreated };
    }

    const [grant] = await tx
      .insert(schema.accessGrants)
      .values({
        organizationId: row.organizationId,
        projectId,
        meetingBotId: row.id,
        objectType: "meeting",
        objectId: row.id,
        relation: "viewer",
        subjectType: "user",
        subjectId: user.id,
        reason: body.reason,
        expiresAt: body.expiresAt,
        createdByActorType: actor.actorType,
        createdByActorId: actor.userId,
      })
      .onConflictDoNothing()
      .returning();
    if (!grant) {
      // A share of the same meeting with the same person committed first: that grant stands.
      const [winner] = await activeGrant();
      if (!winner) throw new Error("access_grants insert returned no row");
      return { created: false, grant: winner, user, userCreated };
    }
    await tx.insert(schema.auditEvents).values({
      action: "access_grant.created",
      actorId: actor.userId,
      actorType: actor.actorType,
      afterJson: { grant: sanitizeGrant(grant) },
      metadataJson: { source: SOURCE },
      organizationId: row.organizationId,
      projectId,
      requestId: input.requestId,
      targetId: grant.id,
      targetType: "access_grant",
    });
    return { created: true, grant, user, userCreated };
  });

  const creator = await findUser(actor.userId);
  return {
    created: result.created,
    userCreated: result.userCreated,
    grant: toGrantSummary(result.grant, { creator, user: result.user }),
  };
}

/** Who was given this meeting, newest last. */
export async function listMeetingAccess(
  input: { meetingId: string; now?: Date; projectRef: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
): Promise<{ grants: MeetingGrantSummary[] }> {
  const now = input.now ?? new Date();
  const row = await loadProjectMeeting(input, "read", deps);
  const rows = await db
    .select({ grant: schema.accessGrants, user: schema.users })
    .from(schema.accessGrants)
    .innerJoin(schema.users, eq(schema.users.id, schema.accessGrants.subjectId))
    .where(
      and(
        eq(schema.accessGrants.meetingBotId, row.id),
        eq(schema.accessGrants.objectType, "meeting"),
        isNull(schema.accessGrants.revokedAt),
        or(isNull(schema.accessGrants.expiresAt), gt(schema.accessGrants.expiresAt, now)),
      ),
    )
    .orderBy(asc(schema.accessGrants.createdAt));
  const creators = await findUsers(rows.flatMap((entry) => (entry.grant.createdByActorId ? [entry.grant.createdByActorId] : [])));
  return {
    grants: rows.map((entry) =>
      toGrantSummary(entry.grant, {
        creator: entry.grant.createdByActorId ? creators.get(entry.grant.createdByActorId) ?? null : null,
        user: entry.user,
      }),
    ),
  };
}

/** Takes one person's access to the meeting away. */
export async function unshareMeeting(
  input: { body: unknown; meetingId: string; now?: Date; projectRef: string; requestId: string; workspace: MeetingsWorkspace },
  deps: MeetingsDeps = {},
): Promise<{ revoked: boolean }> {
  const parsed = unshareBodySchema.safeParse(input.body);
  if (!parsed.success) {
    throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { grantId: "Choose a valid grant." } });
  }
  const now = input.now ?? new Date();
  const row = await loadProjectMeeting(input, "write", deps);
  const [grant] = await db
    .select()
    .from(schema.accessGrants)
    .where(
      and(
        eq(schema.accessGrants.id, parsed.data.grantId),
        eq(schema.accessGrants.meetingBotId, row.id),
        eq(schema.accessGrants.organizationId, row.organizationId),
      ),
    )
    .limit(1);
  if (!grant) throw new ConsoleApiError(404, { error: "grant_not_found" });
  if (grant.revokedAt) return { revoked: false };

  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(schema.accessGrants)
      .set({ revokedAt: now, revokedByActorId: input.workspace.user.id, revokedByActorType: "user", updatedAt: now })
      .where(and(eq(schema.accessGrants.id, grant.id), isNull(schema.accessGrants.revokedAt)))
      .returning();
    if (!revoked) return { revoked: false };
    await tx.insert(schema.auditEvents).values({
      action: "access_grant.revoked",
      actorId: input.workspace.user.id,
      actorType: "user",
      afterJson: { grant: sanitizeGrant(revoked) },
      beforeJson: { grant: sanitizeGrant(grant) },
      metadataJson: { source: SOURCE },
      organizationId: grant.organizationId,
      projectId: grant.projectId,
      requestId: input.requestId,
      targetId: grant.id,
      targetType: "access_grant",
    });
    return { revoked: true };
  });
}

/** Meetings other organizations shared with this person, for "Shared with you". */
export async function listMeetingsSharedWithUser({
  now = new Date(),
  userId,
}: {
  now?: Date;
  userId: string;
}): Promise<SharedMeetingSummary[]> {
  const rows = await db
    .select({ grant: schema.accessGrants, meeting: schema.meetingBots, organization: schema.organizations })
    .from(schema.accessGrants)
    .innerJoin(schema.meetingBots, eq(schema.meetingBots.id, schema.accessGrants.meetingBotId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.accessGrants.organizationId))
    .where(
      and(
        eq(schema.accessGrants.objectType, "meeting"),
        eq(schema.accessGrants.subjectType, "user"),
        eq(schema.accessGrants.subjectId, userId),
        isNull(schema.accessGrants.revokedAt),
        or(isNull(schema.accessGrants.expiresAt), gt(schema.accessGrants.expiresAt, now)),
        eq(schema.organizations.status, "active"),
      ),
    )
    .orderBy(asc(schema.accessGrants.createdAt));
  const creators = await findUsers(rows.flatMap((row) => (row.grant.createdByActorId ? [row.grant.createdByActorId] : [])));
  return rows.map((row) => ({
    grantId: row.grant.id,
    meetingId: row.meeting.id,
    title: row.meeting.title ?? row.meeting.meetingCode,
    organizationName: row.organization.name,
    sharedBy: displayNameFor(row.grant.createdByActorId ? creators.get(row.grant.createdByActorId) : null),
    sharedAt: row.grant.createdAt.toISOString(),
    expiresAt: row.grant.expiresAt?.toISOString() ?? null,
    recordedAt: (row.meeting.recordingStartedAt ?? row.meeting.createdAt).toISOString(),
    path: sharedMeetingPath(row.meeting.id),
  }));
}

function toGrantSummary(grant: GrantRecord, context: { creator: UserRecord | null; user: UserRecord }): MeetingGrantSummary {
  return {
    id: grant.id,
    email: context.user.primaryEmail,
    name: context.user.displayName,
    userId: context.user.id,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    createdAt: grant.createdAt.toISOString(),
    createdBy: displayNameFor(context.creator),
    path: sharedMeetingPath(grant.objectId),
  };
}

function sanitizeGrant(grant: GrantRecord) {
  return {
    expiresAt: grant.expiresAt?.toISOString() ?? null,
    id: grant.id,
    object: `${grant.objectType}:${grant.objectId}`,
    reason: grant.reason,
    relation: grant.relation,
    revokedAt: grant.revokedAt?.toISOString() ?? null,
    subject: `${grant.subjectType}:${grant.subjectId}`,
  };
}

async function findUser(userId: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  return user ?? null;
}

async function findUsers(ids: string[]) {
  const unique = [...new Set(ids.filter((id) => uuidSchema.safeParse(id).success))];
  if (!unique.length) return new Map<string, UserRecord>();
  const rows = await db.select().from(schema.users).where(inArray(schema.users.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

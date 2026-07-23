import {
  agentCan,
  authorizePermission,
  canWithCapabilityContext,
  localOperatorCan,
  type PermissionProvider,
} from "../permissions/provider-runtime.js";
import { parseAuthorityPrincipal } from "../permissions/delegation.js";
import { getScopeContext, type ScopeContext } from "../permissions/scope.js";
import { listCalendarMembers } from "./db.js";
import type { CalendarCalendar, CalendarMemberRelation } from "./types.js";

export type CalendarPermission = "read" | "search" | "free-busy" | "write" | "respond" | "manage";
export type CalendarProviderPermission = "sync" | "manage";
export type CalendarScopeContext = ScopeContext;
export type CalendarAccessLevel = "read" | "free-busy" | "none";
export interface CalendarSubject {
  type: string;
  id: string;
}

export function getCalendarScopeContext(): CalendarScopeContext {
  return getScopeContext();
}

export function canUseCalendar(
  ctx: CalendarScopeContext,
  permission: CalendarPermission,
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId" | "visibility" | "ownerType" | "ownerId">,
): boolean {
  if (!ctx.agentId) return localOperatorCan(permission, "calendar", calendar.id);
  if (calendarScopeSubjects(ctx).some((subject) => calendarSubjectOwnsCalendar(subject, calendar))) return true;
  if (
    calendar.visibility === "public" &&
    (permission === "read" || permission === "search" || permission === "free-busy")
  ) {
    return true;
  }
  return (
    scopeCan(ctx, permission, "calendar", calendar.id) ||
    scopeCan(ctx, permission, "calendar", calendar.name) ||
    Boolean(calendar.providerCalendarId && scopeCan(ctx, permission, "calendar", calendar.providerCalendarId)) ||
    canWithCalendarMembershipProvider(ctx, permission, calendar) ||
    (permission === "free-busy" && hasDetailCalendarAccess(ctx, calendar))
  );
}

export function canUseAnyCalendar(ctx: CalendarScopeContext, permission: CalendarPermission): boolean {
  if (!ctx.agentId) return localOperatorCan(permission, "calendar", "*");
  return scopeCan(ctx, permission, "calendar", "*");
}

export function canUseCalendarProvider(
  ctx: CalendarScopeContext,
  permission: CalendarProviderPermission,
  provider: string,
): boolean {
  if (!ctx.agentId) return localOperatorCan(permission, "calendar-provider", provider);
  return (
    scopeCan(ctx, permission, "calendar-provider", provider) || scopeCan(ctx, permission, "calendar-provider", "*")
  );
}

export function calendarAccessLevel(
  ctx: CalendarScopeContext,
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId" | "visibility" | "ownerType" | "ownerId">,
): CalendarAccessLevel {
  if (canUseCalendar(ctx, "read", calendar) || canUseCalendar(ctx, "search", calendar)) return "read";
  if (canUseCalendar(ctx, "free-busy", calendar)) return "free-busy";
  return "none";
}

export function calendarScopeSubjects(ctx: CalendarScopeContext): CalendarSubject[] {
  const subjects: CalendarSubject[] = [];
  const metadata = ctx.context?.metadata ?? {};
  const actorPrincipal = parseAuthorityPrincipal(metadata.actorPrincipal);

  if (actorPrincipal) {
    subjects.push({ type: actorPrincipal.subjectType, id: actorPrincipal.subjectId });
  }

  const actorType = stringMetadata(metadata, "actorType");
  const contactId = stringMetadata(metadata, "contactId");
  if (actorType === "contact" && contactId) {
    subjects.push({ type: "contact", id: contactId });
  }

  const legacyEnvContactId = ctx.context ? null : stringEnv("RAVI_CONTACT_ID");
  if (legacyEnvContactId) {
    subjects.push({ type: "contact", id: legacyEnvContactId });
  }

  if (ctx.agentId) {
    subjects.push({ type: "agent", id: ctx.agentId });
  }

  return dedupeCalendarSubjects(subjects);
}

export function resolveDefaultCalendarOwnerSubject(ctx: CalendarScopeContext): CalendarSubject {
  const subjects = calendarScopeSubjects(ctx);
  return (
    subjects.find((subject) => subject.type === "contact") ??
    subjects.find((subject) => subject.type === "agent") ??
    subjects.find((subject) => subject.type === "system") ??
    subjects[0] ?? { type: "system", id: "ravi" }
  );
}

function hasDetailCalendarAccess(
  ctx: CalendarScopeContext,
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId" | "visibility" | "ownerType" | "ownerId">,
): boolean {
  return canUseCalendar(ctx, "read", calendar) || canUseCalendar(ctx, "search", calendar);
}

function scopeCan(ctx: CalendarScopeContext, permission: string, objectType: string, objectId: string): boolean {
  if (!ctx.agentId) return localOperatorCan(permission, objectType, objectId);
  if (ctx.context) {
    return canWithCapabilityContext(
      { ...ctx.context, agentId: ctx.context.agentId ?? ctx.agentId },
      permission,
      objectType,
      objectId,
    );
  }
  return agentCan(ctx.agentId, permission, objectType, objectId);
}

function canWithCalendarMembershipProvider(
  ctx: CalendarScopeContext,
  permission: string,
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId">,
): boolean {
  const subjects = calendarScopeSubjects(ctx);
  if (subjects.length === 0 && !ctx.agentId) return localOperatorCan(permission, "calendar", calendar.id);
  return subjects.some(
    (subject) =>
      authorizePermission(
        {
          subject,
          permission,
          objectType: "calendar",
          objectId: calendar.id,
        },
        { providers: [calendarMembershipProvider(calendar)] },
      ).allowed,
  );
}

function calendarSubjectOwnsCalendar(
  subject: CalendarSubject,
  calendar: Pick<CalendarCalendar, "ownerType" | "ownerId">,
): boolean {
  return calendar.ownerType === subject.type && calendar.ownerId === subject.id;
}

function calendarMembershipProvider(
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId">,
): PermissionProvider {
  return {
    id: "calendar-membership",
    version: "calendar/v1",
    required: true,
    supports(request) {
      return (
        request.objectType === "calendar" &&
        Boolean(request.subject?.type && request.subject.id) &&
        calendarObjectMatches(calendar, request.objectId)
      );
    },
    authorize(request) {
      const allowed = Boolean(
        request.subject &&
          calendarSubjectHasPermission(calendar.id, request.subject.type, request.subject.id, request.permission),
      );
      return {
        decision: allowed ? "allow" : "deny",
        allowed,
        providerId: this.id,
        providerVersion: this.version,
        reasonCode: allowed ? "calendar_membership_allow" : "calendar_membership_deny",
        permission: request.permission,
        objectType: request.objectType,
        objectId: request.objectId,
        ...(request.subject ? { subject: request.subject } : {}),
      };
    },
  };
}

function calendarObjectMatches(
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId">,
  objectId: string,
): boolean {
  return objectId === calendar.id || objectId === calendar.name || Boolean(calendar.providerCalendarId === objectId);
}

function calendarSubjectHasPermission(
  calendarId: string,
  subjectType: string,
  subjectId: string,
  permission: string,
): boolean {
  const now = Date.now();
  return listCalendarMembers(calendarId).some((member) => {
    if (member.memberType !== subjectType || member.memberId !== subjectId) return false;
    if (member.expiresAt !== null && member.expiresAt <= now) return false;
    return calendarRelationAllows(member.relation, permission);
  });
}

function calendarRelationAllows(relation: CalendarMemberRelation, permission: string): boolean {
  if (relation === "owner" || relation === "manager") {
    return ["read", "search", "free-busy", "write", "respond", "manage"].includes(permission);
  }
  if (relation === "writer") {
    return ["read", "search", "free-busy", "write", "respond"].includes(permission);
  }
  if (relation === "reader") {
    return ["read", "search", "free-busy"].includes(permission);
  }
  return relation === "free_busy" && permission === "free-busy";
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringEnv(key: string): string | null {
  const value = process.env[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeCalendarSubjects(subjects: CalendarSubject[]): CalendarSubject[] {
  const seen = new Set<string>();
  return subjects.filter((subject) => {
    const key = `${subject.type}:${subject.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

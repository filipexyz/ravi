import {
  agentCan,
  authorizePermission,
  canWithCapabilityContext,
  localOperatorCan,
  type PermissionProvider,
} from "../permissions/provider-runtime.js";
import { getScopeContext, type ScopeContext } from "../permissions/scope.js";
import { listCalendarMembers } from "./db.js";
import type { CalendarCalendar, CalendarMemberRelation } from "./types.js";

export type CalendarPermission = "read" | "search" | "free-busy" | "write" | "respond" | "manage";
export type CalendarProviderPermission = "sync" | "manage";
export type CalendarScopeContext = ScopeContext;
export type CalendarAccessLevel = "read" | "free-busy" | "none";

export function getCalendarScopeContext(): CalendarScopeContext {
  return getScopeContext();
}

export function canUseCalendar(
  ctx: CalendarScopeContext,
  permission: CalendarPermission,
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId" | "visibility" | "ownerType" | "ownerId">,
): boolean {
  if (!ctx.agentId) return localOperatorCan(permission, "calendar", calendar.id);
  if (calendar.ownerType === "agent" && calendar.ownerId === ctx.agentId) return true;
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
  if (!ctx.agentId) return localOperatorCan(permission, "calendar", calendar.id);
  return authorizePermission(
    {
      subject: { type: "agent", id: ctx.agentId },
      permission,
      objectType: "calendar",
      objectId: calendar.id,
    },
    { providers: [calendarMembershipProvider(calendar)] },
  ).allowed;
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

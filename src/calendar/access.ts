import { agentCan } from "../permissions/engine.js";
import { getScopeContext, type ScopeContext } from "../permissions/scope.js";
import type { CalendarCalendar } from "./types.js";

export type CalendarRebacPermission = "read" | "search" | "free-busy" | "write" | "respond" | "manage";
export type CalendarProviderRebacPermission = "sync" | "manage";
export type CalendarScopeContext = ScopeContext;
export type CalendarAccessLevel = "read" | "free-busy" | "none";

export function getCalendarScopeContext(): CalendarScopeContext {
  return getScopeContext();
}

export function canUseCalendar(
  ctx: CalendarScopeContext,
  permission: CalendarRebacPermission,
  calendar: Pick<CalendarCalendar, "id" | "name" | "providerCalendarId" | "visibility" | "ownerType" | "ownerId">,
): boolean {
  if (!ctx.agentId) return true;
  if (calendar.ownerType === "agent" && calendar.ownerId === ctx.agentId) return true;
  if (
    calendar.visibility === "public" &&
    (permission === "read" || permission === "search" || permission === "free-busy")
  ) {
    return true;
  }
  return (
    agentCan(ctx.agentId, permission, "calendar", calendar.id) ||
    agentCan(ctx.agentId, permission, "calendar", calendar.name) ||
    Boolean(
      calendar.providerCalendarId && agentCan(ctx.agentId, permission, "calendar", calendar.providerCalendarId),
    ) ||
    (permission === "free-busy" && hasDetailCalendarAccess(ctx, calendar))
  );
}

export function canUseAnyCalendar(ctx: CalendarScopeContext, permission: CalendarRebacPermission): boolean {
  if (!ctx.agentId) return true;
  return agentCan(ctx.agentId, permission, "calendar", "*");
}

export function canUseCalendarProvider(
  ctx: CalendarScopeContext,
  permission: CalendarProviderRebacPermission,
  provider: string,
): boolean {
  if (!ctx.agentId) return true;
  return (
    agentCan(ctx.agentId, permission, "calendar-provider", provider) ||
    agentCan(ctx.agentId, permission, "calendar-provider", "*")
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

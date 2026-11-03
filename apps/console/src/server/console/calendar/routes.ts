// The calendar routes both envelopes serve (`/api/console/calendar/...` with
// the session cookie, `/api/cli/calendar/...` with the CLI bearer):
//
//   GET  /                         connections, settings, policy, writable projects
//   POST /settings                 change one connection's settings
//   GET  /events                   the person's events (?from&to&updatedSince)
//   GET  /events/:id               one event with its briefing
//   POST /events/:id/decision      record, skip or clear
//   POST /events/:id/briefing      store the briefing (empty deletes)
//   GET  /briefings/:meetingId     the person's own briefing for a meeting bot, or null
//   GET  /policy, POST /policy     the organization's auto-record rule (session only)

import type { CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { parseConsoleRole } from "@/server/console/workspace";

import {
  getCalendarEvent,
  getCalendarOverview,
  getCalendarPolicy,
  getOwnBriefingForMeeting,
  listCalendarEvents,
  setCalendarEventBriefing,
  setCalendarEventDecision,
  updateCalendarPolicy,
  updateCalendarSettings,
  type CalendarWorkspace,
} from "./service";
import { recordCalendarEventNow } from "./tick";

export const CALENDAR_CLI_READ_SCOPES = ["console.projects.read"] as const;
export const CALENDAR_CLI_WRITE_SCOPES = ["console.projects.link"] as const;

export type CalendarRouteRequest = {
  workspace: CalendarWorkspace;
  envelope: "console" | "cli";
  requestId: string;
  method: string;
  segments: readonly string[];
  body: unknown;
  searchParams: URLSearchParams;
};

export type CalendarRouteResult = { status: number; payload: unknown };

export async function routeCalendarRequest(request: CalendarRouteRequest): Promise<CalendarRouteResult> {
  const method = request.method.toUpperCase();
  const { workspace, requestId } = request;
  const [resource, id, action, ...rest] = request.segments;
  const notFound = () => cliApiError(404, "NOT_FOUND", "Unknown calendar route.");

  if (!resource) {
    if (method !== "GET") throw notFound();
    return { status: 200, payload: await getCalendarOverview(workspace) };
  }
  if (resource === "settings" && !id) {
    if (method !== "POST") throw notFound();
    return { status: 200, payload: { connection: await updateCalendarSettings({ body: request.body, requestId, workspace }) } };
  }
  if (resource === "policy" && !id) {
    if (request.envelope !== "console") throw notFound();
    if (method === "GET") return { status: 200, payload: await getCalendarPolicy(workspace) };
    if (method === "POST") return { status: 200, payload: await updateCalendarPolicy({ body: request.body, requestId, workspace }) };
    throw notFound();
  }
  if (resource === "briefings" && id && !action && method === "GET") {
    const briefing = /^[0-9a-f-]{36}$/i.test(id)
      ? await getOwnBriefingForMeeting({ meetingBotId: id, userId: workspace.user.id, organizationId: workspace.organization.id })
      : null;
    return { status: 200, payload: { briefing } };
  }
  if (resource === "events" && rest.length === 0) {
    if (!id) {
      if (method !== "GET") throw notFound();
      return { status: 200, payload: await listCalendarEvents({ searchParams: request.searchParams, workspace }) };
    }
    if (!action && method === "GET") return { status: 200, payload: await getCalendarEvent({ eventId: id, workspace }) };
    if (action === "decision" && method === "POST") {
      return {
        status: 200,
        payload: await setCalendarEventDecision(
          { body: request.body, eventId: id, requestId, workspace },
          { recordNow: (input) => recordCalendarEventNow(input) },
        ),
      };
    }
    if (action === "briefing" && method === "POST") {
      return { status: 200, payload: await setCalendarEventBriefing({ body: request.body, eventId: id, workspace }) };
    }
  }
  throw notFound();
}

export type CalendarCliRequest = Omit<CalendarRouteRequest, "workspace" | "envelope"> & {
  auth: Pick<CliAuthContext, "membership" | "organization" | "scopes" | "user">;
};

export async function handleCalendarCliRequest(request: CalendarCliRequest): Promise<CalendarRouteResult> {
  const write = request.method.toUpperCase() !== "GET";
  for (const scope of write ? CALENDAR_CLI_WRITE_SCOPES : CALENDAR_CLI_READ_SCOPES) {
    if (!request.auth.scopes.includes(scope)) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED", `This CLI session lacks the ${scope} scope. Log in again to grant it.`);
    }
  }
  const role = parseConsoleRole(request.auth.membership.role);
  if (!role) throw cliApiError(403, "ORG_ACCESS_DENIED");
  return routeCalendarRequest({
    ...request,
    envelope: "cli",
    workspace: {
      user: { id: request.auth.user.id },
      organization: { id: request.auth.organization.id },
      membership: { role },
    },
  });
}

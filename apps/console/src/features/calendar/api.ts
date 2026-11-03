"use client";

// Reads and writes for the person's synced calendar: settings on each Google
// connection, upcoming meetings with Record / Don't record, briefings, and the
// organization's auto-record rule. Query keys are scoped to the organization.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useOrgKey } from "@/features/shell/workspace";
import { api } from "@/lib/api/client";

import type {
  CalendarBriefing,
  CalendarConnection,
  CalendarEvent,
  CalendarOverview,
  CalendarPolicy,
  CalendarSettingsInput,
} from "./types";

const BASE = "/api/console/calendar";
/** Upcoming meetings refresh on their own, so a bot sent by the tick shows up without a reload. */
const UPCOMING_REFRESH_MS = 60_000;

export function useCalendarOverview(enabled = true) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<CalendarOverview>(BASE),
    queryKey: orgKey("calendar", "overview"),
  });
}

export function useSaveCalendarSettings() {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CalendarSettingsInput) => api.post<{ connection: CalendarConnection }>(`${BASE}/settings`, input),
    onSuccess: ({ connection }) => {
      queryClient.setQueryData<CalendarOverview>(orgKey("calendar", "overview"), (current) =>
        current
          ? {
              ...current,
              connections: current.connections.map((entry) => (entry.connectionId === connection.connectionId ? connection : entry)),
            }
          : current,
      );
      void queryClient.invalidateQueries({ queryKey: orgKey("calendar", "events") });
    },
  });
}

export function useUpcomingCalendarEvents(enabled = true) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<{ events: CalendarEvent[] }>(`${BASE}/events`),
    queryKey: orgKey("calendar", "events", "upcoming"),
    refetchInterval: UPCOMING_REFRESH_MS,
    select: (data) => data.events.filter((event) => !event.allDay && new Date(event.endAt).getTime() > Date.now()),
  });
}

export function useCalendarDecision() {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { eventId: string; decision: "record" | "skip" | null; projectId?: string }) =>
      api.post<{ event: CalendarEvent }>(`${BASE}/events/${encodeURIComponent(input.eventId)}/decision`, {
        decision: input.decision,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("calendar", "events") }),
  });
}

/** The person's own briefing for a meeting, shown on its page; null when there is none. */
export function useMeetingBriefing(meetingId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ briefing: CalendarBriefing | null }>(`${BASE}/briefings/${encodeURIComponent(meetingId)}`),
    queryKey: orgKey("calendar", "briefings", meetingId),
    select: (data) => data.briefing,
    staleTime: 60_000,
  });
}

export function useCalendarPolicy() {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<CalendarPolicy>(`${BASE}/policy`),
    queryKey: orgKey("calendar", "policy"),
  });
}

export function useSaveCalendarPolicy() {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { autoRecordAllowed: boolean }) => api.post<CalendarPolicy>(`${BASE}/policy`, input),
    onSuccess: (data) => {
      queryClient.setQueryData(orgKey("calendar", "policy"), data);
      void queryClient.invalidateQueries({ queryKey: orgKey("calendar", "overview") });
    },
  });
}

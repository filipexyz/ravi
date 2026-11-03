"use client";

// Reads and writes for meetings (send Ravi, ask it to leave, share one
// meeting by email). Calls go to the Console session envelope
// (`/api/console/projects/<p>/meetings/...`); query keys are scoped to the
// organization and the project. A meeting shared from another organization
// is read at `/api/console/shared/meetings/<id>`. Lists refresh on their own while a bot is
// still moving, so the screen follows a call without a reload.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api/client";
import { withOrganizationParam } from "@/lib/api/organization";
import { useOrgKey } from "@/features/shell/workspace";

import { ACTIVE_REFRESH_MS, refreshInterval } from "./format";
import type {
  Meeting,
  MeetingCreateInput,
  MeetingGrant,
  MeetingRecording,
  MeetingSettings,
  MeetingsSharingSettings,
  SharedMeeting,
  StoredTranscript,
} from "./types";

const LIST_LIMIT = 50;

export function meetingsPath(projectId: string, ...parts: string[]) {
  const suffix = parts.map((part) => `/${encodeURIComponent(part)}`).join("");
  return `/api/console/projects/${encodeURIComponent(projectId)}/meetings${suffix}`;
}

/**
 * A media path from the recording as the browser loads it. Players and
 * downloads can't send the organization header, so it goes in the query.
 */
export function mediaPath(path: string) {
  return withOrganizationParam(path);
}

/** A media path from the recording, set to play in the page instead of downloading. */
export function inlineMediaPath(path: string) {
  const media = mediaPath(path);
  return `${media}${media.includes("?") ? "&" : "?"}inline=1`;
}

export function useMeetings(projectId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ meetings: Meeting[] }>(`${meetingsPath(projectId)}?limit=${LIST_LIMIT}`),
    queryKey: orgKey("projects", projectId, "meetings", "list"),
    refetchInterval: (query) => {
      const intervals = (query.state.data?.meetings ?? []).map((meeting) => refreshInterval(meeting)).filter((ms) => ms !== false);
      return intervals.length ? Math.min(...intervals) : false;
    },
    select: (data) => data.meetings,
  });
}

export function useMeeting(projectId: string, meetingId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<{ meeting: Meeting }>(meetingsPath(projectId, meetingId)),
    queryKey: orgKey("projects", projectId, "meetings", meetingId),
    refetchInterval: (query) => {
      const meeting = query.state.data?.meeting;
      return meeting ? refreshInterval(meeting) : false;
    },
    select: (data) => data.meeting,
  });
}

/** The transcript, participants, chat and media; only asked for once the bot is done. */
export function useMeetingRecording(projectId: string, meetingId: string, enabled: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<MeetingRecording>(meetingsPath(projectId, meetingId, "recording")),
    queryKey: orgKey("projects", projectId, "meetings", meetingId, "recording"),
    // The transcript can land a moment after the media; ask again until it does.
    refetchInterval: (query) => (query.state.data?.transcript.status === "processing" ? ACTIVE_REFRESH_MS : false),
    staleTime: 5 * 60_000,
  });
}

export function useSendMeetingBot(projectId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: MeetingCreateInput) => api.post<{ meeting: Meeting }>(meetingsPath(projectId), input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("projects", projectId, "meetings") }),
  });
}

export function useLeaveMeeting(projectId: string, meetingId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ meeting: Meeting; left: boolean }>(meetingsPath(projectId, meetingId, "leave")),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("projects", projectId, "meetings") }),
  });
}

/**
 * The transcript Ravi kept, asked for only when the recording has none to
 * show. A 404 (nothing kept, or Knowledge off) is an answer, not an error.
 */
export function useStoredTranscript(projectId: string, meetingId: string, enabled: boolean) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: async () => {
      try {
        return await api.get<StoredTranscript>(meetingsPath(projectId, meetingId, "stored-transcript"));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    queryKey: orgKey("projects", projectId, "meetings", meetingId, "stored-transcript"),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

/** People given this meeting by email. Answers 403 to people who can't read the project. */
export function useMeetingAccess(projectId: string, meetingId: string, enabled = true) {
  const orgKey = useOrgKey();
  return useQuery({
    enabled,
    queryFn: () => api.get<{ grants: MeetingGrant[] }>(meetingsPath(projectId, meetingId, "access")),
    queryKey: orgKey("projects", projectId, "meetings", meetingId, "access"),
    retry: false,
    select: (data) => data.grants,
  });
}

export function useShareMeeting(projectId: string, meetingId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; expiresAt: string | null }) =>
      api.post<{ created: boolean; userCreated: boolean; grant: MeetingGrant }>(
        meetingsPath(projectId, meetingId, "access", "share"),
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("projects", projectId, "meetings", meetingId, "access") }),
  });
}

export function useUnshareMeeting(projectId: string, meetingId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) =>
      api.post<{ revoked: boolean }>(meetingsPath(projectId, meetingId, "access", "unshare"), { grantId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKey("projects", projectId, "meetings", meetingId, "access") }),
  });
}

const MEETINGS_SETTINGS_PATH = "/api/console/meetings/settings";

/** Whether agents logged into other organizations may read this organization's meetings. */
export function useMeetingsSharingSettings() {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<MeetingsSharingSettings>(MEETINGS_SETTINGS_PATH),
    queryKey: orgKey("meetings", "settings"),
  });
}

export function useSaveMeetingsSharingSettings() {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { externalAgents: boolean }) => api.post<MeetingsSharingSettings>(MEETINGS_SETTINGS_PATH, input),
    onSuccess: (data) => queryClient.setQueryData(orgKey("meetings", "settings"), data),
  });
}

/** A meeting at `/shared/meetings/<id>`, outside any organization workspace. */
export function useSharedMeeting(meetingId: string) {
  return useQuery({
    queryFn: () => api.get<SharedMeeting>(`/api/console/shared/meetings/${encodeURIComponent(meetingId)}`),
    queryKey: ["shared", "meetings", meetingId],
    retry: false,
    // The transcript can land a moment after the media; ask again until it does.
    refetchInterval: (query) => (query.state.data?.recording?.transcript.status === "processing" ? ACTIVE_REFRESH_MS : false),
    staleTime: 5 * 60_000,
  });
}

/** Deletes the kept transcript for good. Project admins only. */
export function useDeleteStoredTranscript(projectId: string, meetingId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ deleted: boolean; chunks: number }>(meetingsPath(projectId, meetingId, "transcript", "delete")),
    onSuccess: () => {
      queryClient.setQueryData(orgKey("projects", projectId, "meetings", meetingId, "stored-transcript"), null);
    },
  });
}

/** How long the project keeps meeting transcripts, and whether this person may change it. */
export function useMeetingSettings(projectId: string) {
  const orgKey = useOrgKey();
  return useQuery({
    queryFn: () => api.get<MeetingSettings>(meetingsPath(projectId, "settings")),
    queryKey: orgKey("projects", projectId, "meetings", "settings"),
    staleTime: 60_000,
  });
}

export function useUpdateMeetingSettings(projectId: string) {
  const orgKey = useOrgKey();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { transcriptRetentionMonths: number }) => api.post<MeetingSettings>(meetingsPath(projectId, "settings"), input),
    onSuccess: (settings) => queryClient.setQueryData(orgKey("projects", projectId, "meetings", "settings"), settings),
  });
}

/** The server's own sentence for meetings errors, which already say what to do. */
export function meetingErrorText(error: unknown) {
  if (error instanceof ApiError && error.message && error.message !== error.code) return error.message;
  if (error instanceof ApiError && error.code === "RATE_LIMITED") return "The organization's meeting limits were reached.";
  return null;
}

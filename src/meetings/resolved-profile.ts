import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import type { ResolvedMeetingProfile } from "./profiles.js";

export const MEETING_RESOLVED_PROFILE_KIND = "ravi.meetings.resolved_profile" as const;
export const MEETING_RESOLVED_PROFILE_VERSION = 1 as const;
export const RAVI_MEET_RESOLVED_PROFILE_ENV = "RAVI_MEET_RESOLVED_PROFILE" as const;

export interface BuildMeetingResolvedProfileInput {
  generatedAt?: string;
  provider: "google-meet";
  profile?: ResolvedMeetingProfile | null;
  sessionName?: string | null;
  sessionKey?: string | null;
  agentId?: string | null;
  contextId?: string | null;
  nativeRuntime?: boolean;
  providerMeetingId?: string | null;
  bridgeDir?: string | null;
  chromeProfileDir?: string;
  browserChannel?: string;
  voiceRuntimeId?: string | null;
  voiceRuntimeEnabled: boolean;
  liveEnabled: boolean;
  liveContext?: string;
  includeSessionContext?: boolean;
  initialPrompt?: string;
  initialPromptDelay?: string;
  liveTools?: string;
  toolManifestPath?: string;
  toolCount?: number | null;
  out?: string;
  capture?: string;
}

export interface MeetingResolvedProfile {
  kind: typeof MEETING_RESOLVED_PROFILE_KIND;
  version: typeof MEETING_RESOLVED_PROFILE_VERSION;
  generatedAt: string;
  provider: "google-meet";
  sourceProfile: {
    id: string | null;
    version: string | null;
    sourceKind: string | null;
    source: string | null;
    profilePath: string | null;
  };
  session: {
    key?: string;
    name?: string;
    agentId?: string;
    contextId?: string;
    nativeRuntime?: boolean;
    providerMeetingId?: string;
    bridgeDir?: string;
  };
  chrome: {
    profileDir?: string;
    browserChannel?: string;
  };
  voice: {
    runtimeId: string | null;
    enabled: boolean;
  };
  live: {
    enabled: boolean;
    context?: string;
    contextChars: number;
    includeSessionContext: boolean;
    initialPrompt?: string;
    initialPromptChars: number;
    initialPromptDelay?: string;
    tools: {
      selection: string[];
      manifestPath?: string;
      count: number | null;
    };
  };
  defaults: {
    out?: string;
    capture?: string;
  };
}

export interface WrittenMeetingResolvedProfile {
  profile: MeetingResolvedProfile;
  path: string;
}

export function buildMeetingResolvedProfile(input: BuildMeetingResolvedProfileInput): MeetingResolvedProfile {
  const runtimeId = input.voiceRuntimeId?.trim() || null;
  const toolSelection = input.liveTools
    ? input.liveTools
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean)
    : [];

  return {
    kind: MEETING_RESOLVED_PROFILE_KIND,
    version: MEETING_RESOLVED_PROFILE_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    provider: input.provider,
    sourceProfile: {
      id: input.profile?.id ?? null,
      version: input.profile?.version ?? null,
      sourceKind: input.profile?.sourceKind ?? null,
      source: input.profile?.source ?? null,
      profilePath: input.profile?.profilePath ?? null,
    },
    session: omitUndefined({
      key: input.sessionKey?.trim() || undefined,
      name: input.sessionName?.trim() || undefined,
      agentId: input.agentId?.trim() || undefined,
      contextId: input.contextId?.trim() || undefined,
      nativeRuntime: input.nativeRuntime ?? (input.voiceRuntimeEnabled ? true : undefined),
      providerMeetingId: input.providerMeetingId?.trim() || undefined,
      bridgeDir: input.bridgeDir?.trim() || undefined,
    }),
    chrome: omitUndefined({
      profileDir: input.chromeProfileDir?.trim() || input.profile?.chrome.profileDir,
      browserChannel: input.browserChannel?.trim() || input.profile?.chrome.browserChannel,
    }),
    voice: omitUndefined({
      runtimeId,
      enabled: input.voiceRuntimeEnabled,
    }),
    live: {
      enabled: input.liveEnabled,
      ...(input.liveContext?.trim() ? { context: input.liveContext.trim() } : {}),
      contextChars: input.liveContext?.trim().length ?? 0,
      includeSessionContext: Boolean(input.includeSessionContext),
      ...(input.initialPrompt?.trim() ? { initialPrompt: input.initialPrompt.trim() } : {}),
      initialPromptChars: input.initialPrompt?.trim().length ?? 0,
      ...(input.initialPromptDelay?.trim() ? { initialPromptDelay: input.initialPromptDelay.trim() } : {}),
      tools: omitUndefined({
        selection: toolSelection,
        manifestPath: input.toolManifestPath?.trim() || undefined,
        count: input.toolCount ?? null,
      }),
    },
    defaults: omitUndefined({
      out: input.out?.trim() || undefined,
      capture: input.capture?.trim() || undefined,
    }),
  };
}

export function writeMeetingResolvedProfile(
  input: BuildMeetingResolvedProfileInput & { label?: string; dir?: string },
): WrittenMeetingResolvedProfile {
  const profile = buildMeetingResolvedProfile(input);
  const dir = input.dir?.trim() || join(getRaviStateDir(), "meetings", "resolved-profiles");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeProfileLabel(input.label || input.sessionName || input.contextId || Date.now())}.json`);
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  return { profile, path };
}

export function readMeetingResolvedProfile(path: string): MeetingResolvedProfile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as MeetingResolvedProfile;
  if (parsed.kind !== MEETING_RESOLVED_PROFILE_KIND) {
    throw new Error(`Invalid meeting resolved profile kind at ${path}: ${String(parsed.kind)}`);
  }
  if (parsed.version !== MEETING_RESOLVED_PROFILE_VERSION) {
    throw new Error(`Unsupported meeting resolved profile version at ${path}: ${String(parsed.version)}`);
  }
  return parsed;
}

export function publicMeetingResolvedProfile(
  profile: MeetingResolvedProfile,
  path?: string | null,
): Record<string, unknown> {
  return {
    kind: profile.kind,
    version: profile.version,
    generatedAt: profile.generatedAt,
    provider: profile.provider,
    sourceProfile: profile.sourceProfile,
    session: {
      name: profile.session.name ?? null,
      key: profile.session.key ?? null,
      agentId: profile.session.agentId ?? null,
      contextId: profile.session.contextId ?? null,
      nativeRuntime: profile.session.nativeRuntime ?? null,
      providerMeetingId: profile.session.providerMeetingId ?? null,
      bridgeDir: profile.session.bridgeDir ?? null,
    },
    chrome: {
      profileDir: profile.chrome.profileDir ?? null,
      browserChannel: profile.chrome.browserChannel ?? null,
    },
    voice: {
      runtimeId: profile.voice.runtimeId,
      enabled: profile.voice.enabled,
    },
    live: {
      enabled: profile.live.enabled,
      contextChars: profile.live.contextChars,
      includeSessionContext: profile.live.includeSessionContext,
      initialPromptChars: profile.live.initialPromptChars,
      initialPromptDelay: profile.live.initialPromptDelay ?? null,
      tools: {
        selection: profile.live.tools.selection,
        manifestPath: profile.live.tools.manifestPath ?? null,
        count: profile.live.tools.count,
      },
    },
    defaults: profile.defaults,
    resolvedProfilePath: path ?? null,
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function safeProfileLabel(value: string | number): string {
  return (
    String(value)
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "meeting-profile"
  );
}

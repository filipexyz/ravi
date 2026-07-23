import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { getRaviStateDir } from "../utils/paths.js";
import { DEFAULT_MEETING_VOICE_RUNTIME_ID } from "./voice-runtime.js";

export const DEFAULT_MEETING_PROFILE_ID = "default";

export type MeetingProfileSourceKind = "system" | "workspace" | "user";

export interface MeetingProfileChromeConfig {
  profileDir?: string;
  browserChannel?: string;
}

export interface MeetingProfileVoiceConfig {
  runtime: string;
}

export interface MeetingProfileLiveConfig {
  enabled: boolean;
  agentId?: string;
  context?: string;
  includeSessionContext: boolean;
  initialPrompt?: string;
  initialPromptDelay?: string;
  tools: string[];
}

export interface MeetingProfileDefaults {
  name?: string;
  out?: string;
  duration?: string;
  maxDuration?: string;
  emptyGrace?: string;
  capture?: string;
}

export interface ResolvedMeetingProfile {
  id: string;
  version: string;
  label: string;
  description: string;
  enabled: boolean;
  provider: "google-meet";
  chrome: MeetingProfileChromeConfig;
  voice: MeetingProfileVoiceConfig;
  live: MeetingProfileLiveConfig;
  defaults: MeetingProfileDefaults;
  sourceKind: MeetingProfileSourceKind;
  source: string;
  profileDir: string | null;
  profilePath: string | null;
}

export interface MeetingProfileValidationResult {
  id: string;
  sourceKind: MeetingProfileSourceKind;
  source: string;
  valid: boolean;
  error?: string;
}

export interface InitMeetingProfileResult {
  sourceKind: "workspace" | "user";
  profileDir: string;
  profilePath: string;
}

const PROFILE_FILENAME = "profile.json";
const WORKSPACE_PROFILE_SEGMENTS = [".ravi", "meetings", "profiles"] as const;
const USER_PROFILE_SEGMENTS = ["meetings", "profiles"] as const;
const MEETING_PROFILE_SOURCE_PRECEDENCE: MeetingProfileSourceKind[] = ["system", "workspace", "user"];

const MeetingProfileSchema = z
  .object({
    id: z.string().trim().min(1),
    version: z.string().trim().min(1),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    enabled: z.boolean().default(true),
    provider: z.literal("google-meet").default("google-meet"),
    chrome: z
      .object({
        profileDir: z.string().trim().min(1).optional(),
        browserChannel: z.string().trim().min(1).optional(),
      })
      .default({}),
    voice: z
      .object({
        runtime: z.string().trim().min(1).default(DEFAULT_MEETING_VOICE_RUNTIME_ID),
      })
      .default({
        runtime: DEFAULT_MEETING_VOICE_RUNTIME_ID,
      }),
    live: z
      .object({
        enabled: z.boolean().default(false),
        agentId: z.string().trim().min(1).optional(),
        context: z.string().trim().min(1).optional(),
        includeSessionContext: z.boolean().default(false),
        initialPrompt: z.string().trim().min(1).optional(),
        initialPromptDelay: z.string().trim().min(1).optional(),
        tools: z.array(z.string().trim().min(1)).default([]),
      })
      .default({ enabled: false, includeSessionContext: false, tools: [] }),
    defaults: z
      .object({
        name: z.string().trim().min(1).optional(),
        out: z.string().trim().min(1).optional(),
        duration: z.string().trim().min(1).optional(),
        maxDuration: z.string().trim().min(1).optional(),
        emptyGrace: z.string().trim().min(1).optional(),
        capture: z.string().trim().min(1).optional(),
      })
      .default({}),
  })
  .strict();

type MeetingProfileManifest = z.infer<typeof MeetingProfileSchema>;

interface MeetingProfileCandidate {
  id: string;
  manifest: unknown;
  source: string;
  profileDir: string | null;
  path: string | null;
}

interface MeetingProfileSourceBucket {
  sourceKind: MeetingProfileSourceKind;
  candidates: MeetingProfileCandidate[];
}

const SYSTEM_MEETING_PROFILES: MeetingProfileManifest[] = [
  {
    id: DEFAULT_MEETING_PROFILE_ID,
    version: "1",
    label: "Default Google Meet profile",
    description: "Default reusable Google Meet profile with the persistent recorder Chrome profile.",
    enabled: true,
    provider: "google-meet",
    chrome: {
      profileDir: "~/.ravi/meet-recorder/chrome-profile",
      browserChannel: "chrome",
    },
    voice: {
      runtime: DEFAULT_MEETING_VOICE_RUNTIME_ID,
    },
    live: {
      enabled: false,
      includeSessionContext: false,
      tools: [],
    },
    defaults: {},
  },
];

export function listMeetingProfiles(input: { cwd?: string; userDir?: string } = {}): ResolvedMeetingProfile[] {
  const catalog = loadMeetingProfileCatalog(input);
  return [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveMeetingProfile(
  profileId?: string | null,
  input: { cwd?: string; userDir?: string } = {},
): ResolvedMeetingProfile {
  const requestedId = normalizeMeetingProfileId(profileId) ?? DEFAULT_MEETING_PROFILE_ID;
  const catalog = loadMeetingProfileCatalog(input);
  const profile = catalog.get(requestedId);
  if (!profile) {
    throw new Error(
      `Unknown meeting profile: ${requestedId}. Available profiles: ${[...catalog.keys()].sort().join(", ")}.`,
    );
  }
  if (!profile.enabled) {
    throw new Error(`Meeting profile is disabled: ${requestedId}.`);
  }
  return profile;
}

export function validateMeetingProfiles(
  profileId?: string | null,
  input: { cwd?: string; userDir?: string } = {},
): MeetingProfileValidationResult[] {
  const requestedId = normalizeMeetingProfileId(profileId);
  const sources = listProfileSources(input);
  const results: MeetingProfileValidationResult[] = [];

  for (const source of sources) {
    for (const candidate of source.candidates) {
      if (requestedId && candidate.id !== requestedId) continue;
      try {
        resolveProfileManifest(
          candidate.manifest,
          source.sourceKind,
          candidate.source,
          candidate.profileDir,
          candidate.path,
        );
        results.push({
          id: candidate.id,
          sourceKind: source.sourceKind,
          source: candidate.source,
          valid: true,
        });
      } catch (error) {
        results.push({
          id: candidate.id,
          sourceKind: source.sourceKind,
          source: candidate.source,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id) || a.sourceKind.localeCompare(b.sourceKind));
}

export function initMeetingProfile(
  profileId: string,
  input: { sourceKind?: "workspace" | "user"; cwd?: string; userDir?: string } = {},
): InitMeetingProfileResult {
  const id = normalizeMeetingProfileId(profileId);
  if (!id) throw new Error("Meeting profile id is required.");
  const sourceKind = input.sourceKind ?? "workspace";
  const root =
    sourceKind === "workspace"
      ? joinPath(resolvePath(input.cwd ?? process.cwd()), ...WORKSPACE_PROFILE_SEGMENTS)
      : joinPath(input.userDir ?? getRaviStateDir(), ...USER_PROFILE_SEGMENTS);
  const profileDir = joinPath(root, id);
  const profilePath = joinPath(profileDir, PROFILE_FILENAME);
  if (existsSync(profilePath)) {
    throw new Error(`Meeting profile already exists: ${profilePath}`);
  }
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(profilePath, `${JSON.stringify(buildProfileScaffold(id), null, 2)}\n`, "utf8");
  return { sourceKind, profileDir, profilePath };
}

export function publicMeetingProfile(profile: ResolvedMeetingProfile): Record<string, unknown> {
  return {
    id: profile.id,
    version: profile.version,
    label: profile.label,
    sourceKind: profile.sourceKind,
    source: profile.source,
    provider: profile.provider,
    chrome: {
      profileDir: profile.chrome.profileDir ?? null,
      browserChannel: profile.chrome.browserChannel ?? null,
    },
    voice: {
      runtime: profile.voice.runtime,
    },
    live: {
      enabled: profile.live.enabled,
      agentId: profile.live.agentId ?? null,
      contextChars: profile.live.context?.length ?? 0,
      includeSessionContext: profile.live.includeSessionContext,
      initialPromptChars: profile.live.initialPrompt?.length ?? 0,
      initialPromptDelay: profile.live.initialPromptDelay ?? null,
      tools: profile.live.tools,
    },
    defaults: profile.defaults,
  };
}

function loadMeetingProfileCatalog(input: { cwd?: string; userDir?: string }): Map<string, ResolvedMeetingProfile> {
  const catalog = new Map<string, ResolvedMeetingProfile>();
  for (const source of listProfileSources(input)) {
    for (const candidate of source.candidates) {
      const profile = resolveProfileManifest(
        candidate.manifest,
        source.sourceKind,
        candidate.source,
        candidate.profileDir,
        candidate.path,
      );
      catalog.set(profile.id, profile);
    }
  }
  return catalog;
}

function listProfileSources(input: { cwd?: string; userDir?: string }) {
  const sources: MeetingProfileSourceBucket[] = MEETING_PROFILE_SOURCE_PRECEDENCE.map((sourceKind) => ({
    sourceKind,
    candidates: [],
  }));

  const bySourceKind = new Map(sources.map((source) => [source.sourceKind, source]));
  for (const manifest of SYSTEM_MEETING_PROFILES) {
    bySourceKind.get("system")?.candidates.push({
      id: manifest.id,
      manifest,
      source: "system",
      profileDir: null,
      path: null,
    });
  }

  loadProfilesFromDirectory(
    joinPath(resolvePath(input.cwd ?? process.cwd()), ...WORKSPACE_PROFILE_SEGMENTS),
    "workspace",
    bySourceKind,
  );
  loadProfilesFromDirectory(
    joinPath(input.userDir ?? getRaviStateDir(), ...USER_PROFILE_SEGMENTS),
    "user",
    bySourceKind,
  );
  return sources;
}

function loadProfilesFromDirectory(
  root: string,
  sourceKind: MeetingProfileSourceKind,
  bySourceKind: Map<MeetingProfileSourceKind, MeetingProfileSourceBucket>,
): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const profileDir = joinPath(root, entry.name);
    const profilePath = joinPath(profileDir, PROFILE_FILENAME);
    if (!existsSync(profilePath)) continue;
    bySourceKind.get(sourceKind)?.candidates.push({
      id: entry.name,
      manifest: JSON.parse(readFileSync(profilePath, "utf8")) as unknown,
      source: profilePath,
      profileDir,
      path: profilePath,
    });
  }
}

function resolveProfileManifest(
  raw: unknown,
  sourceKind: MeetingProfileSourceKind,
  source: string,
  profileDir: string | null,
  profilePath: string | null,
): ResolvedMeetingProfile {
  const manifest = MeetingProfileSchema.parse(raw);
  return {
    ...manifest,
    voice: {
      ...manifest.voice,
      runtime: manifest.voice.runtime ?? DEFAULT_MEETING_VOICE_RUNTIME_ID,
    },
    sourceKind,
    source,
    profileDir,
    profilePath,
  };
}

function normalizeMeetingProfileId(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function buildProfileScaffold(id: string): MeetingProfileManifest {
  return {
    id,
    version: "1",
    label: id,
    description: "Reusable Google Meet profile.",
    enabled: true,
    provider: "google-meet",
    chrome: {
      profileDir: "~/.ravi/meet-recorder/chrome-profile",
      browserChannel: "chrome",
    },
    voice: {
      runtime: DEFAULT_MEETING_VOICE_RUNTIME_ID,
    },
    live: {
      enabled: false,
      includeSessionContext: false,
      tools: [],
    },
    defaults: {},
  };
}

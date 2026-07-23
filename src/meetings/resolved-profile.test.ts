import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEETING_RESOLVED_PROFILE_KIND,
  RAVI_MEET_RESOLVED_PROFILE_ENV,
  buildMeetingResolvedProfile,
  publicMeetingResolvedProfile,
  readMeetingResolvedProfile,
  writeMeetingResolvedProfile,
} from "./resolved-profile.js";
import type { ResolvedMeetingProfile } from "./profiles.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("meeting resolved profile", () => {
  it("captures chrome, voice and live configuration in one provider contract", () => {
    const profile = buildMeetingResolvedProfile({
      provider: "google-meet",
      profile: exampleMeetingProfile(),
      sessionKey: "agent:ravi-meet-v0:meet:google-meet:abc-defg-hij:20260627t200000z",
      sessionName: "ravi-meet-v0",
      agentId: "ravi-meet-v0",
      contextId: "ctx_1",
      nativeRuntime: true,
      providerMeetingId: "abc-defg-hij",
      bridgeDir: "/tmp/ravi-meet-bridge",
      chromeProfileDir: "~/.ravi/chrome/custom",
      voiceRuntimeId: "ravi-native",
      voiceRuntimeEnabled: true,
      initialPrompt: "abre a conversa",
      initialPromptDelay: "3",
      liveEnabled: true,
      liveContext: "contexto privado",
      includeSessionContext: true,
      liveTools: "tasks_list,artifacts_show",
      toolManifestPath: "/tmp/tools.json",
    });
    const publicProfile = publicMeetingResolvedProfile(profile, "/tmp/resolved.json");

    expect(profile.kind).toBe(MEETING_RESOLVED_PROFILE_KIND);
    expect(profile.chrome.profileDir).toBe("~/.ravi/chrome/custom");
    expect(profile.chrome.browserChannel).toBe("chrome");
    expect(profile.voice.runtimeId).toBe("ravi-native");
    expect(profile.live.initialPrompt).toBe("abre a conversa");
    expect(publicProfile).toMatchObject({
      resolvedProfilePath: "/tmp/resolved.json",
      session: {
        key: "agent:ravi-meet-v0:meet:google-meet:abc-defg-hij:20260627t200000z",
        nativeRuntime: true,
        providerMeetingId: "abc-defg-hij",
        bridgeDir: "/tmp/ravi-meet-bridge",
      },
      chrome: {
        profileDir: "~/.ravi/chrome/custom",
        browserChannel: "chrome",
      },
      voice: {
        runtimeId: "ravi-native",
      },
      live: {
        initialPromptChars: 15,
        tools: {
          selection: ["tasks_list", "artifacts_show"],
          manifestPath: "/tmp/tools.json",
          count: null,
        },
      },
    });
    expect(JSON.stringify(publicProfile)).not.toContain("prompt privado");
    expect(JSON.stringify(publicProfile)).not.toContain("abre a conversa");
    expect(JSON.stringify(publicProfile)).not.toContain("contexto privado");
  });

  it("writes and reads the private resolved profile for provider workers", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ravi-meeting-profile-test-"));
    const written = writeMeetingResolvedProfile({
      dir: tempDir,
      label: "meeting-live-test",
      provider: "google-meet",
      profile: exampleMeetingProfile(),
      sessionKey: "agent:ravi-meet-v0:meet:google-meet:abc-defg-hij:20260627t200000z",
      sessionName: "meet-google-meet-abc-defg-hij-20260627t200000z",
      agentId: "ravi-meet-v0",
      nativeRuntime: true,
      providerMeetingId: "abc-defg-hij",
      bridgeDir: "/tmp/ravi-meet-bridge",
      voiceRuntimeId: "ravi-native",
      voiceRuntimeEnabled: true,
      liveEnabled: true,
    });
    const raw = await readFile(written.path, "utf8");
    const parsed = JSON.parse(raw) as { kind: string; session: { key: string } };
    const loaded = readMeetingResolvedProfile(written.path);

    expect(written.path.endsWith("meeting-live-test.json")).toBe(true);
    expect(parsed.kind).toBe(MEETING_RESOLVED_PROFILE_KIND);
    expect(parsed.session.key).toBe("agent:ravi-meet-v0:meet:google-meet:abc-defg-hij:20260627t200000z");
    expect(loaded.kind).toBe(MEETING_RESOLVED_PROFILE_KIND);
    expect(RAVI_MEET_RESOLVED_PROFILE_ENV).toBe("RAVI_MEET_RESOLVED_PROFILE");
  });
});

function exampleMeetingProfile(): ResolvedMeetingProfile {
  return {
    id: "default",
    version: "1",
    label: "Default",
    description: "Default profile",
    enabled: true,
    provider: "google-meet",
    chrome: {
      profileDir: "~/.ravi/meet-recorder/chrome-profile",
      browserChannel: "chrome",
    },
    voice: {
      runtime: "ravi-native",
    },
    live: {
      enabled: false,
      includeSessionContext: false,
      tools: [],
    },
    defaults: {},
    sourceKind: "system",
    source: "system:default",
    profileDir: null,
    profilePath: null,
  };
}

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMeetingProfile,
  listMeetingProfiles,
  publicMeetingProfile,
  resolveMeetingProfile,
  validateMeetingProfiles,
} from "./profiles.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("meeting profiles", () => {
  it("provides a system default with the recorder Chrome profile", () => {
    const profile = resolveMeetingProfile("default", { userDir: "/tmp/ravi-missing-user-profiles" });

    expect(profile).toMatchObject({
      id: "default",
      provider: "google-meet",
      chrome: {
        profileDir: "~/.ravi/meet-recorder/chrome-profile",
        browserChannel: "chrome",
      },
      voice: {
        runtime: "ravi-native",
      },
    });
    expect(publicMeetingProfile(profile)).toMatchObject({
      id: "default",
      chrome: {
        profileDir: "~/.ravi/meet-recorder/chrome-profile",
      },
    });
  });

  it("lets workspace profiles override system profiles by id", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ravi-meeting-profile-test-"));
    const profileDir = join(tempDir, ".ravi", "meetings", "profiles", "default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, "profile.json"),
      JSON.stringify(
        {
          id: "default",
          version: "2",
          label: "Workspace Default",
          description: "Workspace override.",
          provider: "google-meet",
          chrome: { profileDir: "~/.ravi/meet-recorder/workspace-chrome" },
          voice: { runtime: "ravi-native" },
          live: { enabled: false, includeSessionContext: false, tools: [] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const profile = resolveMeetingProfile("default", {
      cwd: tempDir,
      userDir: "/tmp/ravi-missing-user-profiles",
    });

    expect(profile.version).toBe("2");
    expect(profile.sourceKind).toBe("workspace");
    expect(profile.chrome.profileDir).toBe("~/.ravi/meet-recorder/workspace-chrome");
    expect(profile.voice.runtime).toBe("ravi-native");
  });

  it("validates and initializes profile scaffolds", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ravi-meeting-profile-init-test-"));
    const created = initMeetingProfile("team-live", { cwd: tempDir, sourceKind: "workspace" });
    const profiles = listMeetingProfiles({ cwd: tempDir, userDir: "/tmp/ravi-missing-user-profiles" });
    const validation = validateMeetingProfiles("team-live", {
      cwd: tempDir,
      userDir: "/tmp/ravi-missing-user-profiles",
    });

    expect(created.profilePath.endsWith(".ravi/meetings/profiles/team-live/profile.json")).toBe(true);
    expect(profiles.map((profile) => profile.id)).toContain("team-live");
    expect(validation).toEqual([expect.objectContaining({ id: "team-live", valid: true })]);
  });
});

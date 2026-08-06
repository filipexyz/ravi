import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { MeetingProfileCommands, MeetingsCommands } from "./meetings.js";

let tempDir: string | undefined;
let previousPath: string | undefined;
let previousOpenAiApiKey: string | undefined;
let previousRecorderBin: string | undefined;

// Spawning a bash stub is not possible on Windows; resolution still works via
// RAVI_GOOGLE_MEET_RECORDER_BIN, so only spawn-dependent tests are skipped.
const isWindows = process.platform === "win32";

describe("MeetingsCommands", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ravi-meetings-command-test-"));
    previousPath = process.env.PATH;
    previousOpenAiApiKey = process.env.OPENAI_API_KEY;
    previousRecorderBin = process.env.RAVI_GOOGLE_MEET_RECORDER_BIN;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const executable = join(binDir, "meet-record");
    await writeFile(executable, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    // PATH-based lookup (X_OK + ':' separator) is POSIX-only; the explicit BIN
    // override keeps provider RESOLUTION working on every platform.
    process.env.RAVI_GOOGLE_MEET_RECORDER_BIN = executable;
  });

  afterEach(async () => {
    process.env.PATH = previousPath;
    if (previousOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiApiKey;
    if (previousRecorderBin === undefined) delete process.env.RAVI_GOOGLE_MEET_RECORDER_BIN;
    else process.env.RAVI_GOOGLE_MEET_RECORDER_BIN = previousRecorderBin;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    previousPath = undefined;
    previousOpenAiApiKey = undefined;
    previousRecorderBin = undefined;
  });

  it("validates Google Meet provider invocation without joining on dry-run", async () => {
    const { output, result } = await captureConsole(() =>
      new MeetingsCommands().join(
        "google-meet",
        "https://meet.google.com/abc-defg-hij",
        "Ravi",
        "/tmp/ravi-meetings",
        undefined,
        undefined,
        "120",
        "5",
        "webrtc-tap",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    const payload = JSON.parse(output) as {
      mode: string;
      provider: string;
      args: string[];
      voiceRuntime: Record<string, unknown>;
    };
    expect(result).toMatchObject({ mode: "dry-run", provider: "google-meet" });
    expect(payload).toMatchObject({ mode: "dry-run", provider: "google-meet" });
    expect(payload.args).toEqual(
      expect.arrayContaining([
        "--url",
        "https://meet.google.com/abc-defg-hij",
        "--until-empty",
        "--out",
        "/tmp/ravi-meetings",
        "--name",
        "Ravi",
        "--max-duration",
        "120",
        "--empty-grace",
        "5",
        "--capture",
        "webrtc-tap",
      ]),
    );
    expect(payload.voiceRuntime).toMatchObject({
      enabled: false,
      runtimeId: null,
      runnable: true,
    });
  });

  it("lists meeting voice runtime candidates", async () => {
    const { output, result } = await captureConsole(() => new MeetingsCommands().voiceRuntimes(true));

    const payload = JSON.parse(output) as { defaultRuntimeId: string; candidates: Array<{ id: string }> };
    expect(result.defaultRuntimeId).toBe("ravi-native");
    expect(payload.defaultRuntimeId).toBe("ravi-native");
    expect(payload.candidates.map((candidate) => candidate.id)).toEqual(["ravi-native", "pipecat", "livekit"]);
  });

  it("lists and shows reusable meeting profiles", async () => {
    const { output, result } = await captureConsole(() => new MeetingProfileCommands().show("default", true));

    const payload = JSON.parse(output) as { id: string; chrome: { profileDir: string } };
    expect(result).toMatchObject({
      id: "default",
      chrome: {
        profileDir: "~/.ravi/meet-recorder/chrome-profile",
      },
    });
    expect(payload.id).toBe("default");
    expect(payload.chrome.profileDir).toBe("~/.ravi/meet-recorder/chrome-profile");
  });

  it("uses meeting profile defaults through join --profile", async () => {
    const { output, result } = await captureConsole(() =>
      new MeetingsCommands().join(
        "google-meet",
        "https://meet.google.com/abc-defg-hij",
        undefined,
        "/tmp/ravi-meetings",
        undefined,
        undefined,
        "120",
        "5",
        "webrtc-tap",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        false,
        undefined,
        undefined,
        undefined,
        true,
        true,
        undefined,
        "default",
      ),
    );

    const payload = JSON.parse(output) as {
      args: string[];
      meetingProfile: { id: string; chrome: { profileDir: string } };
      resolvedMeetingProfile: { chrome: { profileDir: string; browserChannel: string } };
    };
    expect(result).toMatchObject({
      meetingProfile: {
        id: "default",
      },
    });
    expect(payload.args).not.toContain("--profile-dir");
    expect(payload.meetingProfile.chrome.profileDir).toBe("~/.ravi/meet-recorder/chrome-profile");
    expect(payload.resolvedMeetingProfile.chrome).toEqual({
      profileDir: "~/.ravi/meet-recorder/chrome-profile",
      browserChannel: "chrome",
    });
  });

  it("blocks live mode until the native Meet voice bridge is wired", async () => {
    await expect(
      runWithContext({ sessionKey: "meeting-test", sessionName: "meeting-test", agentId: "ravi-meet-v0" }, () =>
        new MeetingsCommands().join(
          "google-meet",
          "https://meet.google.com/abc-defg-hij",
          "Ravi",
          "/tmp/ravi-meetings",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "entrei para testar",
          "3",
          undefined,
          "ravi-meet-v0",
          "teste live",
          true,
          true,
          false,
          undefined,
          undefined,
          undefined,
          true,
          true,
          undefined,
          "default",
        ),
      ),
    ).rejects.toThrow("native Meet voice bridge");
  });

  it.skipIf(isWindows)("opens Google Meet provider login with the selected persistent profile", async () => {
    const { output, result } = await captureConsole(() =>
      new MeetingsCommands().login(
        "google-meet",
        "/tmp/ravi-meetings-login-profile",
        "chrome-beta",
        "https://meet.google.com/abc-defg-hij",
        "1440x900",
        true,
      ),
    );

    const payload = JSON.parse(output) as {
      provider: string;
      profileDir: string;
      browserChannel: string;
      url: string;
      viewport: string;
      args: string[];
      exitCode: number;
    };
    expect(result).toMatchObject({
      provider: "google-meet",
      providerRuntime: "google-meet-recorder",
      profileDir: "/tmp/ravi-meetings-login-profile",
      browserChannel: "chrome-beta",
      url: "https://meet.google.com/abc-defg-hij",
      viewport: "1440x900",
      exitCode: 0,
    });
    expect(payload).toMatchObject(result);
    expect(payload.args).toEqual([
      "login",
      "--profile-dir",
      "/tmp/ravi-meetings-login-profile",
      "--browser-channel",
      "chrome-beta",
      "--url",
      "https://meet.google.com/abc-defg-hij",
      "--viewport",
      "1440x900",
    ]);
  });

  it("voice-runtimes payload conforms to meetingVoiceRuntimesReturnSchema", async () => {
    const { meetingVoiceRuntimesReturnSchema } = await import("./operational-return-schemas.js");
    const { output } = await captureConsole(() => new MeetingsCommands().voiceRuntimes(true));
    const payload = JSON.parse(output);
    const parsed = meetingVoiceRuntimesReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("profiles.show payload conforms to meetingProfileReturnSchema", async () => {
    const { meetingProfileReturnSchema } = await import("./operational-return-schemas.js");
    const { output } = await captureConsole(() => new MeetingProfileCommands().show("default", true));
    const payload = JSON.parse(output);
    const parsed = meetingProfileReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("profiles.list payload conforms to meetingProfilesListReturnSchema", async () => {
    const { meetingProfilesListReturnSchema } = await import("./operational-return-schemas.js");
    const { output } = await captureConsole(() => new MeetingProfileCommands().list(true));
    const payload = JSON.parse(output);
    const parsed = meetingProfilesListReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("profiles.validate payload conforms to meetingProfilesValidateReturnSchema", async () => {
    const { meetingProfilesValidateReturnSchema } = await import("./operational-return-schemas.js");
    const { output } = await captureConsole(() => new MeetingProfileCommands().validate(undefined, true));
    const payload = JSON.parse(output);
    const parsed = meetingProfilesValidateReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Agent-first contract (Manual v2): not-found envelope, --fields, and the
  // documented --dry-run write-brake equivalent on join (flag NOT renamed).
  // Nested so the recorder-stub beforeEach applies.
  // -------------------------------------------------------------------------
  describe("meetings agent-first contract", () => {
    async function expectContractError(
      run: () => Promise<unknown> | unknown,
      code: string,
      exitCode: number,
    ): Promise<InstanceType<typeof ContractError>> {
      let caught: unknown;
      await runWithContext({ sessionKey: "meet-test", sessionName: "meet-test", agentId: "meet-test" }, async () => {
        await captureConsole(async () => {
          try {
            await run();
          } catch (error) {
            caught = error;
          }
        });
      });
      expect(caught).toBeInstanceOf(ContractError);
      const contractError = caught as InstanceType<typeof ContractError>;
      expect(contractError.code).toBe(code);
      expect(contractError.exitCode).toBe(exitCode);
      return contractError;
    }

    it("profiles show on an unknown id exits 1 with MEETING_PROFILE_NOT_FOUND and local suggestions", async () => {
      const error = await expectContractError(
        () => new MeetingProfileCommands().show("defualt", true),
        "MEETING_PROFILE_NOT_FOUND",
        1,
      );

      expect(error.op).toBe("meetings profiles show");
      expect(error.details.suggestions).toContain("default");
      expect(error.details.suggestedAction).toContain("ravi meetings profiles list");
    });

    it("join with an unknown --profile exits 1 with MEETING_PROFILE_NOT_FOUND before touching the provider", async () => {
      const error = await expectContractError(
        () =>
          new MeetingsCommands().join(
            "google-meet",
            "https://meet.google.com/abc-defg-hij",
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
            false,
            undefined,
            undefined,
            undefined,
            true,
            true,
            undefined,
            "ghost-profile",
          ),
        "MEETING_PROFILE_NOT_FOUND",
        1,
      );

      expect(error.op).toBe("meetings join");
    });

    it("profiles list --fields narrows items and the profiles alias equally", async () => {
      const { result } = await captureConsole(() =>
        new MeetingProfileCommands().list(true, undefined, undefined, "id,label"),
      );

      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items as Array<Record<string, unknown>>) {
        expect(Object.keys(item).sort()).toEqual(["id", "label"]);
      }
      expect(result.profiles).toEqual(result.items);
    });

    it("join --dry-run stays the documented write-brake equivalent: validates and joins nothing", async () => {
      const { result } = await captureConsole(() =>
        new MeetingsCommands().join(
          "google-meet",
          "https://meet.google.com/abc-defg-hij",
          "Ravi",
          "/tmp/ravi-meetings",
          undefined,
          undefined,
          "120",
          "5",
          "webrtc-tap",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          false,
          undefined,
          undefined,
          undefined,
          true,
          true,
        ),
      );

      expect(result).toMatchObject({ mode: "dry-run", provider: "google-meet" });
    });
  });
});

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

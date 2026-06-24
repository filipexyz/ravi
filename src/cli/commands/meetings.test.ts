import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeetingsCommands } from "./meetings.js";

let tempDir: string | undefined;
let previousPath: string | undefined;

describe("MeetingsCommands", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ravi-meetings-command-test-"));
    previousPath = process.env.PATH;
    const binDir = join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const executable = join(binDir, "meet-record");
    await writeFile(executable, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = previousPath;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    previousPath = undefined;
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
        false,
        false,
        false,
        undefined,
        "pt",
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    const payload = JSON.parse(output) as { mode: string; provider: string; args: string[] };
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
        "--realtime-language",
        "pt",
      ]),
    );
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

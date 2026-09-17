import { describe, expect, it } from "bun:test";
import { classifyFatalToolFailure } from "./fatal-tool-failure.js";

describe("classifyFatalToolFailure", () => {
  it("ignores successful tool results", () => {
    expect(classifyFatalToolFailure({ isError: false, content: "Exit code 137" })).toEqual({
      fatal: false,
      summary: "",
    });
  });

  it("does not treat ordinary command failures as fatal", () => {
    expect(
      classifyFatalToolFailure({
        isError: true,
        toolName: "Bash",
        content: "ls: no such file\nExit code 1",
      }).fatal,
    ).toBe(false);
    expect(
      classifyFatalToolFailure({
        isError: true,
        content: "Command failed with exit code 127",
      }).fatal,
    ).toBe(false);
  });

  it("classifies SIGKILL / exit 137 as fatal", () => {
    expect(
      classifyFatalToolFailure({
        isError: true,
        toolName: "Bash",
        content: "Command failed with exit code 137\nKilled",
      }),
    ).toMatchObject({
      fatal: true,
      reason: "sigkill",
      exitCode: 137,
    });
    expect(
      classifyFatalToolFailure({
        isError: true,
        content: [{ type: "text", text: "bash: killed by SIGKILL" }],
      }),
    ).toMatchObject({
      fatal: true,
      reason: "sigkill",
    });
  });

  it("reads fatal exit codes from metadata", () => {
    expect(
      classifyFatalToolFailure({
        isError: true,
        content: "child process died",
        metadata: { exitCode: 139 },
      }),
    ).toMatchObject({
      fatal: true,
      reason: "sigsegv",
      exitCode: 139,
    });
  });
});

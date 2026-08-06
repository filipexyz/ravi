/**
 * Agent-first contract tests for the `video` CLI domain (Manual v2): the write
 * brake guards the PAID Gemini path (strategy `gemini`, `--force-analyze`, and
 * the `auto` default that may fall back to Gemini), while the free/local
 * subtitles-only path (`--strategy subtitles`) runs without `--execute`.
 * Follows the group.test.ts pattern: no-op decorator mocks + service mocks with
 * spies + `hasContext: () => true` so the contract helpers throw ContractError
 * instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const analyzeCalls: Array<{ url: string; prompt?: string; strategy?: string }> = [];

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: () => () => {},
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../video/gemini.js", () => ({
  analyzeVideo: mock(async (url: string, prompt?: string, options?: { strategy?: string }) => {
    analyzeCalls.push({ url, prompt, strategy: options?.strategy });
    return {
      source: url,
      strategy: options?.strategy === "gemini" ? "gemini" : "subtitles",
      title: "Video Teste",
      duration: "10:00",
      summary: "Resumo do vídeo.",
      topics: ["tema"],
      transcript: "fala transcrita",
      visualDescription: "",
      subtitleLanguage: "pt",
      chapters: [],
      markdown: "# Video Teste\n\nfala transcrita\n",
    };
  }),
}));

const { VideoCommands } = await import("./video.js");
const { ContractError } = await import("../agent-contract.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

async function captureConsole<T>(run: () => T | Promise<T>): Promise<{ output: string; result: T }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    const result = await run();
    return { output: lines.join("\n"), result };
  } finally {
    console.log = originalLog;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await captureConsole(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

beforeEach(() => {
  analyzeCalls.length = 0;
});

describe("video analyze contract", () => {
  it("default strategy (auto) without --execute is a dry-run: exit 3 and NO analysis call", async () => {
    const error = await expectContractError(
      () => new VideoCommands().analyze("https://youtu.be/abc", undefined, undefined, undefined, undefined, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      url: "https://youtu.be/abc",
      strategy: "auto",
      paidPath: "gemini-fallback-possible",
      freeAlternative: "ravi video analyze <url> --strategy subtitles",
    });
    expect(analyzeCalls).toHaveLength(0);
  });

  it("--force-analyze (gemini) without --execute is a dry-run showing the paid model", async () => {
    const error = await expectContractError(
      () => new VideoCommands().analyze("https://youtu.be/abc", undefined, undefined, undefined, true, true),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({
      strategy: "gemini",
      paidPath: "gemini",
    });
    expect((error.details.plan as { model: string }).model.length).toBeGreaterThan(0);
    expect(analyzeCalls).toHaveLength(0);
  });

  it("--strategy subtitles is the free/local path: runs WITHOUT --execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-video-test-"));
    const output = join(dir, "analysis.md");
    try {
      const { result } = await captureConsole(() =>
        new VideoCommands().analyze("https://youtu.be/abc", output, undefined, "subtitles", undefined, true),
      );

      expect(analyzeCalls).toEqual([{ url: "https://youtu.be/abc", prompt: undefined, strategy: "subtitles" }]);
      expect((result as { success: boolean }).success).toBe(true);
      expect(readFileSync(output, "utf8")).toContain("Video Teste");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gemini strategy with --execute performs the paid analysis", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-video-test-"));
    const output = join(dir, "analysis.md");
    try {
      const { result } = await captureConsole(() =>
        new VideoCommands().analyze("https://youtu.be/abc", output, "foque no tema", "gemini", undefined, true, true),
      );

      expect(analyzeCalls).toEqual([{ url: "https://youtu.be/abc", prompt: "foque no tema", strategy: "gemini" }]);
      expect((result as { options: { strategy: string } }).options.strategy).toBe("gemini");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the strategy BEFORE the brake", async () => {
    await expect(
      new VideoCommands().analyze("https://youtu.be/abc", undefined, undefined, "bogus", undefined, true),
    ).rejects.toThrow("Invalid video analysis strategy");
    expect(analyzeCalls).toHaveLength(0);
  });
});

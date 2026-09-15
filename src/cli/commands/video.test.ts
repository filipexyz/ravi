/**
 * Agent-first contract tests for the `video` CLI domain: analysis runs
 * immediately for auto, subtitles and Gemini strategies because there is no
 * configured cost threshold/estimate contract and no external delivery.
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

beforeEach(() => {
  analyzeCalls.length = 0;
});

describe("video analyze contract", () => {
  it("default auto strategy runs directly without --execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-video-test-"));
    const output = join(dir, "analysis.md");
    try {
      const { result } = await captureConsole(() =>
        new VideoCommands().analyze("https://youtu.be/abc", output, undefined, undefined, undefined, true),
      );

      expect(analyzeCalls).toEqual([{ url: "https://youtu.be/abc", prompt: undefined, strategy: "auto" }]);
      expect((result as { success: boolean }).success).toBe(true);
      expect(readFileSync(output, "utf8")).toContain("Video Teste");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--force-analyze runs the Gemini strategy directly without --execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-video-test-"));
    const output = join(dir, "analysis.md");
    try {
      await captureConsole(() =>
        new VideoCommands().analyze("https://youtu.be/abc", output, undefined, undefined, true, true),
      );

      expect(analyzeCalls).toEqual([{ url: "https://youtu.be/abc", prompt: undefined, strategy: "gemini" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("gemini strategy performs the analysis without --execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-video-test-"));
    const output = join(dir, "analysis.md");
    try {
      const { result } = await captureConsole(() =>
        new VideoCommands().analyze("https://youtu.be/abc", output, "foque no tema", "gemini", undefined, true),
      );

      expect(analyzeCalls).toEqual([{ url: "https://youtu.be/abc", prompt: "foque no tema", strategy: "gemini" }]);
      expect((result as { options: { strategy: string } }).options.strategy).toBe("gemini");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the strategy before analysis", async () => {
    const sentinel = "PRIVATE_STRATEGY_9M2Q";
    let failure: unknown;
    try {
      await new VideoCommands().analyze("https://youtu.be/abc", undefined, undefined, sentinel, undefined, true);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "USAGE_ERROR",
      message: "Invalid video analysis strategy.",
      exitCode: 2,
    });
    expect(JSON.stringify(failure)).not.toContain(sentinel);
    expect(analyzeCalls).toHaveLength(0);
  });
});

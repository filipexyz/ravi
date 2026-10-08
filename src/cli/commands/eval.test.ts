import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import type { EvalRunResult } from "../../eval/runner.js";
import { loadEvalTaskSpec } from "../../eval/spec.js";

let nextResult: EvalRunResult;

mock.module("../../eval/runner.js", () => ({
  runEvalTask: async () => nextResult,
}));

afterAll(() => mock.restore());

const { EvalCommands, evalRunPassed } = await import("./eval.js");
const { runWithContext } = await import("../context.js");

const repoRoot = join(import.meta.dir, "..", "..", "..");
const tempRoots: string[] = [];

function writeSpec(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-eval-cli-"));
  tempRoots.push(root);
  const path = join(root, "spec.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      id: "exit-code",
      prompt: "Responda exatamente com EVAL_OK",
      session: { name: "eval-exit-code", agentId: "dev" },
      rubric: [{ id: "ok", type: "response.contains", needle: "EVAL_OK" }],
    }),
  );
  return path;
}

function makeResult(state: EvalRunResult["execution"]["state"], pass: boolean, error?: string): EvalRunResult {
  return {
    runId: "run-1",
    outputDir: "/tmp/ravi-eval-run-1",
    session: { sessionName: "eval-exit-code", sessionKey: "agent:dev:eval-exit-code", agentId: "dev" },
    execution: { state, responseText: pass ? "EVAL_OK" : "nope", durationMs: 12, ...(error ? { error } : {}) },
    before: {} as EvalRunResult["before"],
    after: {} as EvalRunResult["after"],
    diff: {} as EvalRunResult["diff"],
    grade: {
      pass,
      passed: pass ? 1 : 0,
      total: 1,
      score: pass ? 1 : 0,
      criteria: [{ id: "ok", type: "response.contains", pass, details: pass ? "found" : "missing" }],
    },
  };
}

async function runCaptured(asJson: boolean, context?: Parameters<typeof runWithContext>[0]) {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const run = () => new EvalCommands().run(writeSpec(), undefined, asJson);
    const result = context ? await runWithContext(context, run) : await run();
    return { result, output: lines.join("\n") };
  } finally {
    console.log = originalLog;
  }
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("eval run exit code", () => {
  it("passes only a completed turn whose rubric passed", () => {
    expect(evalRunPassed(makeResult("complete", true))).toBe(true);
    expect(evalRunPassed(makeResult("complete", false))).toBe(false);
    for (const state of ["failed", "interrupted", "timeout"] as const) {
      expect(evalRunPassed(makeResult(state, true, "boom"))).toBe(false);
    }
  });

  it("prints the full JSON result and then exits 1 when the grade fails", async () => {
    nextResult = makeResult("complete", false);
    const { result, output } = await runCaptured(true);

    expect(result).toBe(nextResult);
    expect(JSON.parse(output)).toMatchObject({ runId: "run-1", grade: { pass: false } });
    expect(process.exitCode).toBe(1);
  });

  it("prints the text summary and then exits 1 when the turn timed out", async () => {
    nextResult = makeResult("timeout", true, "Timed out waiting for response from eval-exit-code after 120s");
    const { output } = await runCaptured(false);

    expect(output).toContain("State:      timeout");
    expect(output).toContain("Error:      Timed out waiting");
    expect(output).toContain("✓ ok (response.contains)");
    expect(process.exitCode).toBe(1);
  });

  it("keeps exit code 0 when the run passes", async () => {
    nextResult = makeResult("complete", true);
    await runCaptured(true);
    expect(process.exitCode).toBe(0);
    await runCaptured(false);
    expect(process.exitCode).toBe(0);
  });

  it("never sets the host process exit code inside the daemon", async () => {
    nextResult = makeResult("failed", false, "Session failed");

    const viaGateway = await runCaptured(true, { suppressCliOutput: true, transport: "gateway" });
    expect(viaGateway.result).toBe(nextResult);
    expect(process.exitCode).toBe(0);

    const viaTool = await runCaptured(true, { transport: "tool" });
    expect(viaTool.result).toBe(nextResult);
    expect(process.exitCode).toBe(0);
  });
});

describe("examples/eval specs", () => {
  const examplesDir = join(repoRoot, "examples", "eval");
  const specPaths = readdirSync(examplesDir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".json"))
    .map((path) => join(examplesDir, path))
    .sort();

  it("finds the example specs", () => {
    expect(specPaths.length).toBeGreaterThan(1);
  });

  for (const path of specPaths) {
    it(`loads ${relative(repoRoot, path)} with the strict schema, named after its id`, () => {
      const task = loadEvalTaskSpec(path);
      expect(task.spec.id).toBe(basename(path, ".json"));
      expect(task.spec.session.agentId).toBeTruthy();
    });
  }
});

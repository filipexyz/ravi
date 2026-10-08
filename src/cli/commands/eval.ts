/**
 * Eval Commands - reproducible task harness for Ravi
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import { resolveCallerPath } from "../caller-cwd.js";
import { fail, getContext } from "../context.js";
import { looseObjectSchema } from "../return-schemas.js";
import { EVAL_MAX_TIMEOUT_MS, loadEvalTaskSpec } from "../../eval/spec.js";
import { runEvalTask, type EvalRunResult } from "../../eval/runner.js";

const evalRunReturnSchema = z
  .object({
    runId: z.string(),
    outputDir: z.string(),
    session: looseObjectSchema,
    execution: looseObjectSchema,
    grade: looseObjectSchema,
  })
  .passthrough();

/** A run passes only when its turn completed and every rubric criterion passed. */
export function evalRunPassed(result: Pick<EvalRunResult, "execution" | "grade">): boolean {
  return result.execution.state === "complete" && result.grade.pass;
}

/**
 * Exit 1 after printing a run that did not pass, so scripts can branch on the
 * exit code. Only a local CLI process owns its exit code: through the gateway
 * or as an in-process tool the command runs inside the daemon, which keeps its own.
 */
function setEvalRunExitCode(result: EvalRunResult): void {
  if (evalRunPassed(result)) return;
  const ctx = getContext({ localOnly: true });
  if (ctx?.suppressCliOutput === true || ctx?.transport !== undefined) return;
  process.exitCode = 1;
}

@Group({
  name: "eval",
  description: "Run reproducible evaluation tasks against Ravi",
  scope: "admin",
})
export class EvalCommands {
  @Command({
    name: "run",
    description: "Run an eval task spec and persist artifacts",
    // A run waits for a whole agent turn (runner.timeoutMs, up to 10 min);
    // the default 30 s gateway wait would cut it off when called from a session.
    remoteTimeoutMs: EVAL_MAX_TIMEOUT_MS + 60_000,
  })
  @CommandAccess({ kind: "mutate", resource: "eval", action: "run", risk: "high" })
  @Returns(evalRunReturnSchema)
  async run(
    @Arg("specPath", { description: "Path to the eval task spec JSON" }) specPath: string,
    @Option({ flags: "--output <dir>", description: "Optional output directory for run artifacts" }) output?: string,
    @Option({ flags: "--json", description: "Print final run summary as JSON" }) asJson?: boolean,
  ) {
    try {
      // Through the gateway this runs in the daemon; resolve paths against the caller's cwd.
      const task = loadEvalTaskSpec(resolveCallerPath(specPath));
      const result = await runEvalTask(task, output ? resolveCallerPath(output) : undefined);

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        setEvalRunExitCode(result);
        return result;
      }

      console.log(`\nEval: ${task.spec.title ?? task.spec.id}`);
      console.log(`Spec:       ${task.path}`);
      console.log(`Run ID:     ${result.runId}`);
      console.log(`Session:    ${result.session.sessionName} (${result.session.agentId})`);
      console.log(`State:      ${result.execution.state}`);
      console.log(`Duration:   ${result.execution.durationMs}ms`);
      console.log(
        `Score:      ${result.grade.passed}/${result.grade.total} (${Math.round(result.grade.score * 100)}%)`,
      );
      console.log(`Pass:       ${result.grade.pass ? "yes" : "no"}`);
      console.log(`Artifacts:  ${result.outputDir}`);

      if (result.execution.error) {
        console.log(`Error:      ${result.execution.error}`);
      }

      if (result.execution.responseText.trim()) {
        const preview = result.execution.responseText.replace(/\s+/g, " ").trim().slice(0, 200);
        console.log(`Response:   ${preview}`);
      }

      console.log("\nCriteria:\n");
      for (const criterion of result.grade.criteria) {
        const status = criterion.pass ? "✓" : "✗";
        console.log(`  ${status} ${criterion.id} (${criterion.type})`);
        console.log(`    ${criterion.details}`);
      }

      console.log();
      setEvalRunExitCode(result);
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

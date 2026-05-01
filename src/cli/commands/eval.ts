/**
 * Eval Commands - reproducible task harness for Ravi
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { loadEvalTaskSpec } from "../../eval/spec.js";
import { runEvalTask } from "../../eval/runner.js";

@Group({
  name: "eval",
  description: "Run reproducible evaluation tasks against Ravi",
  scope: "admin",
  skillGate: "ravi-system-tasks-eval",
})
export class EvalCommands {
  @Command({ name: "run", description: "Run an eval task spec and persist artifacts" })
  async run(
    @Arg("specPath", { description: "Path to the eval task spec JSON" }) specPath: string,
    @Option({ flags: "--output <dir>", description: "Optional output directory for run artifacts" }) output?: string,
    @Option({ flags: "--json", description: "Print final run summary as JSON" }) asJson?: boolean,
  ) {
    try {
      const task = loadEvalTaskSpec(specPath);
      const result = await runEvalTask(task, output);

      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
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
      return result;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

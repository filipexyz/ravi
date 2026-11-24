/**
 * Sandbox Commands - run one Ravi task in a disposable cloud sandbox (E2B)
 */

import { assertCallerFileAccess, resolveCallerPath } from "../caller-cwd.js";
import "reflect-metadata";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import {
  DEFAULT_E2B_TEMPLATE,
  DEFAULT_E2B_TEMPLATE_REF,
  DEFAULT_SANDBOX_MODEL,
  DEFAULT_SANDBOX_TIMEOUT_MIN,
  buildE2bTemplate,
  resolveE2bApiKey,
  resolveSandboxCredentials,
  runE2bSandboxTask,
} from "../../sandbox/e2b.js";

const sandboxRunReturnSchema = z.object({
  sandboxId: z.string(),
  taskId: z.string().nullable(),
  status: z.string(),
  kept: z.boolean(),
  outputDir: z.string(),
  files: z.array(z.string()),
  durationMs: z.number(),
  error: z.string().nullable(),
});
const sandboxTemplateBuildReturnSchema = z.object({
  name: z.string(),
  templateId: z.string(),
  ref: z.string(),
  durationMs: z.number(),
});
function parsePositiveNumber(value: string | undefined, label: string, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${label} must be a positive number.`);
  return parsed;
}

function readInstructions(task?: string, taskFile?: string): string {
  if (task?.trim() && taskFile?.trim()) fail("Use either --task or --task-file, not both.");
  if (task?.trim()) return task;
  if (taskFile?.trim()) {
    try {
      return readFileSync(taskFile, "utf8");
    } catch (error) {
      fail(`Cannot read --task-file: ${errorMessage(error)}`);
    }
  }
  fail("--task or --task-file is required.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@Group({
  name: "sandbox",
  description: "Run one Ravi task in a disposable E2B cloud sandbox and collect its patch",
  scope: "admin",
})
export class SandboxCommands {
  @Command({
    name: "run",
    description: "Boot a sandbox from the template, clone a repo, run one task and save TASK.md, patch and logs",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "sandbox",
    action: "run",
    risk: "high",
  })
  // Host-local only: it reads --task-file and writes --output on the executing
  // host, and runs for up to an hour, so it is not exposed through the gateway/SDK.
  @CliOnly()
  @Returns(sandboxRunReturnSchema)
  async run(
    @Option({
      flags: "--repo <url>",
      description: "Git URL to clone into the sandbox",
    })
    repo?: string,
    @Option({ flags: "--task <text>", description: "Task instructions" })
    task?: string,
    @Option({
      flags: "--task-file <path>",
      description: "Read task instructions from a file",
    })
    taskFile?: string,
    @Option({
      flags: "--title <title>",
      description: "Task title",
      defaultValue: "Sandbox task",
    })
    title?: string,
    @Option({ flags: "--branch <branch>", description: "Branch to clone" })
    branch?: string,
    @Option({
      flags: "--template <name>",
      description: "E2B template name",
      defaultValue: DEFAULT_E2B_TEMPLATE,
    })
    template?: string,
    @Option({
      flags: "--model <model>",
      description: "Worker model",
      defaultValue: DEFAULT_SANDBOX_MODEL,
    })
    model?: string,
    @Option({
      flags: "--timeout-min <minutes>",
      description: `Task timeout in minutes (default ${DEFAULT_SANDBOX_TIMEOUT_MIN})`,
    })
    timeoutMin?: string,
    @Option({
      flags: "--keep",
      description: "Pause the sandbox instead of killing it",
    })
    keep?: boolean,
    @Option({
      flags: "--output <dir>",
      description: "Where to save outputs (default ~/.ravi/sandbox-runs/<id>)",
    })
    output?: string,
    @Option({ flags: "--json", description: "Print the run summary as JSON" })
    asJson?: boolean,
  ) {
    if (!repo?.trim()) fail("--repo is required.");
    const instructions = readInstructions(task, taskFile);
    const timeout = parsePositiveNumber(timeoutMin, "--timeout-min", DEFAULT_SANDBOX_TIMEOUT_MIN);

    let credentials;
    try {
      credentials = resolveSandboxCredentials();
    } catch (error) {
      fail(errorMessage(error));
    }

    let result;
    try {
      if (output?.trim()) assertCallerFileAccess(resolveCallerPath(output, "write"), "write");
      result = await runE2bSandboxTask({
        repo,
        instructions,
        title,
        branch,
        template,
        model,
        timeoutMin: timeout,
        keep,
        outputDir: output,
        credentials,
        onStep: asJson ? undefined : (message) => console.log(message),
      });
    } catch (error) {
      fail(errorMessage(error));
    }

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`\nStatus:   ${result.status}`);
      if (result.taskId) console.log(`Task:     ${result.taskId}`);
      console.log(`Sandbox:  ${result.sandboxId}${result.kept ? " (paused)" : ""}`);
      console.log(`Outputs:  ${result.outputDir}`);
      if (result.error) console.log(`Error:    ${result.error}`);
    }
    if (result.status !== "done") process.exitCode = 1;
    return result;
  }
}

@Group({
  name: "sandbox.template",
  description: "Build the E2B template that sandbox runs boot from",
  scope: "admin",
})
export class SandboxTemplateCommands {
  @Command({
    name: "build",
    description: "Build (or rebuild) the E2B template with Bun, nats-server and Ravi",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "sandbox",
    action: "template.build",
    risk: "medium",
  })
  // A template build runs for several minutes, longer than a gateway call may
  // stay idle, so like `sandbox run` it is only available from the CLI.
  @CliOnly()
  @Returns(sandboxTemplateBuildReturnSchema)
  async build(
    @Arg("name", { description: "Template name", required: false })
    name?: string,
    @Option({
      flags: "--ref <ref>",
      description: `Ravi branch or tag baked into the template (default ${DEFAULT_E2B_TEMPLATE_REF})`,
    })
    ref?: string,
    @Option({ flags: "--cpu <count>", description: "vCPUs (default 2)" })
    cpu?: string,
    @Option({
      flags: "--memory <mb>",
      description: "Memory in MB (default 4096)",
    })
    memory?: string,
    @Option({ flags: "--json", description: "Print the build result as JSON" })
    asJson?: boolean,
  ) {
    let apiKey: string;
    try {
      apiKey = resolveE2bApiKey();
    } catch (error) {
      fail(errorMessage(error));
    }

    try {
      const result = await buildE2bTemplate({
        name: name ?? DEFAULT_E2B_TEMPLATE,
        ref,
        cpu: parsePositiveNumber(cpu, "--cpu", 2),
        memoryMB: parsePositiveNumber(memory, "--memory", 4096),
        apiKey,
        onLog: asJson ? undefined : (line) => console.log(line),
      });
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\nTemplate ready: ${result.name} (id ${result.templateId}, ref ${result.ref})`);
      }
      return result;
    } catch (error) {
      fail(errorMessage(error));
    }
  }
}

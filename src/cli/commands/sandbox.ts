/**
 * Sandbox Commands - run one Ravi task in a disposable cloud sandbox (E2B)
 */

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONTRACT_EXIT_USAGE, contractFail } from "../agent-contract.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import {
  DEFAULT_E2B_TEMPLATE,
  DEFAULT_E2B_TEMPLATE_REF,
  DEFAULT_SANDBOX_MODEL,
  DEFAULT_SANDBOX_TIMEOUT_MIN,
  MAX_SANDBOX_TIMEOUT_MIN,
  MAX_TASK_TEXT_BYTES,
  SANDBOX_EGRESS_MODES,
  SANDBOX_GITHUB_AUTH_MODES,
  SANDBOX_MODEL_AUTH_MODES,
  type SandboxEgressMode,
  type SandboxGithubAuthMode,
  type SandboxModelAuthMode,
  buildE2bTemplate,
  resolveE2bApiKey,
  resolveSandboxCredentials,
  runE2bSandboxTask,
} from "../../sandbox/e2b.js";
import { collectE2bTelemetry, type E2bTelemetrySummary } from "../../sandbox/observe.js";
import { getRaviStateDir } from "../../utils/paths.js";

const e2bTelemetrySummarySchema = z.object({
  logLines: z.number(),
  processes: z.number(),
  failedProcesses: z.number(),
  events: z.array(z.string()),
  killReason: z.string().nullable(),
  executionMs: z.number().nullable(),
  metricSamples: z.number(),
  peakCpuPct: z.number().nullable(),
  peakMemMB: z.number().nullable(),
  memTotalMB: z.number().nullable(),
  peakDiskMB: z.number().nullable(),
  errors: z.array(z.string()),
});

const sandboxRunReturnSchema = z.object({
  sandboxId: z.string(),
  taskId: z.string().nullable(),
  status: z.string(),
  kept: z.boolean(),
  outputDir: z.string(),
  files: z.array(z.string()),
  durationMs: z.number(),
  error: z.string().nullable(),
  e2b: e2bTelemetrySummarySchema.nullable(),
});
const sandboxLogsReturnSchema = z.object({
  sandboxId: z.string(),
  outputDir: z.string(),
  files: z.array(z.string()),
  e2b: e2bTelemetrySummarySchema,
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

function failRunUsage(message: string, asJson: boolean | undefined, acceptedValues?: readonly string[]): never {
  contractFail("sandbox run", "USAGE_ERROR", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: {
      suggestedAction: "Fix the flag and re-run `ravi sandbox run`.",
      ...(acceptedValues ? { acceptedValues: [...acceptedValues] } : {}),
    },
  });
}

export interface SandboxRunFlags {
  timeoutMin?: string;
  modelAuth?: string;
  allowKeyInEnv?: boolean;
  egress?: string;
  allowHost?: string[];
  githubAuth?: string;
  keep?: boolean;
}

export interface ValidatedSandboxRunFlags {
  timeoutMin: number;
  modelAuth: SandboxModelAuthMode | undefined;
  egress: SandboxEgressMode;
  allowHosts: string[];
  githubAuth: SandboxGithubAuthMode;
}

const HOST_RE = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * Flag validation for `sandbox run`; every rejection is a usage error (exit 2) before any
 * network call. `env` is only read to tell an explicit `--model-auth broker` that has no
 * broker URL apart from a configuration problem later on.
 */
export function validateSandboxRunFlags(
  flags: SandboxRunFlags,
  asJson?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): ValidatedSandboxRunFlags {
  let timeoutMin = DEFAULT_SANDBOX_TIMEOUT_MIN;
  if (flags.timeoutMin?.trim()) {
    const raw = flags.timeoutMin.trim();
    timeoutMin = Number(raw);
    if (!/^\d+$/.test(raw) || timeoutMin < 1 || timeoutMin > MAX_SANDBOX_TIMEOUT_MIN) {
      failRunUsage(`--timeout-min must be an integer from 1 to ${MAX_SANDBOX_TIMEOUT_MIN}, got ${raw}.`, asJson);
    }
  }
  let modelAuth: SandboxModelAuthMode | undefined;
  if (flags.modelAuth !== undefined) {
    if (!(SANDBOX_MODEL_AUTH_MODES as readonly string[]).includes(flags.modelAuth)) {
      failRunUsage(
        `--model-auth must be one of ${SANDBOX_MODEL_AUTH_MODES.join(", ")}.`,
        asJson,
        SANDBOX_MODEL_AUTH_MODES,
      );
    }
    modelAuth = flags.modelAuth as SandboxModelAuthMode;
  }
  if (modelAuth === "env" && !flags.allowKeyInEnv) {
    failRunUsage(
      "--model-auth env puts the real API key in the sandbox environment, where E2B logs and snapshots can see it. " +
        "Pass --allow-key-in-env to accept that, or use header/broker mode.",
      asJson,
    );
  }
  if (modelAuth === "env" && flags.keep) {
    failRunUsage("--keep is refused with --model-auth env: the paused snapshot would hold the API key.", asJson);
  }
  if (modelAuth === "broker" && !env.RAVI_SANDBOX_ANTHROPIC_BASE_URL?.trim()) {
    failRunUsage(
      "--model-auth broker needs RAVI_SANDBOX_ANTHROPIC_BASE_URL (an https URL the sandbox sends model traffic to).",
      asJson,
    );
  }
  let githubAuth: SandboxGithubAuthMode = "header";
  if (flags.githubAuth !== undefined) {
    if (!(SANDBOX_GITHUB_AUTH_MODES as readonly string[]).includes(flags.githubAuth)) {
      failRunUsage(
        `--github-auth must be one of ${SANDBOX_GITHUB_AUTH_MODES.join(", ")}.`,
        asJson,
        SANDBOX_GITHUB_AUTH_MODES,
      );
    }
    githubAuth = flags.githubAuth as SandboxGithubAuthMode;
  }
  let egress: SandboxEgressMode = "dev-registries";
  if (flags.egress !== undefined) {
    if (!(SANDBOX_EGRESS_MODES as readonly string[]).includes(flags.egress)) {
      failRunUsage(`--egress must be one of ${SANDBOX_EGRESS_MODES.join(", ")}.`, asJson, SANDBOX_EGRESS_MODES);
    }
    egress = flags.egress as SandboxEgressMode;
  }
  const allowHosts = (flags.allowHost ?? [])
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const host of allowHosts) {
    if (!HOST_RE.test(host))
      failRunUsage(`--allow-host entries must be host names (optionally *.suffix), got ${host}.`, asJson);
  }
  return { timeoutMin, modelAuth, egress, allowHosts, githubAuth };
}

/**
 * Title and instructions are written into the sandbox and expanded with `$(cat …)`;
 * the cap keeps that well inside what a command line and E2B's file API take, and a
 * task that needs more text should carry it in the repository instead.
 */
export function validateTaskText(title: string, instructions: string, asJson?: boolean): void {
  const bytes = Buffer.byteLength(title) + Buffer.byteLength(instructions);
  if (bytes > MAX_TASK_TEXT_BYTES) {
    failRunUsage(
      `--title and --task/--task-file together are ${bytes} bytes; the limit is ${MAX_TASK_TEXT_BYTES} (100 KiB). ` +
        "Put the long material in the repository and refer to it from the task.",
      asJson,
    );
  }
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

function printTelemetry(summary: E2bTelemetrySummary): void {
  console.log(
    `E2B:      ${summary.processes} processes (${summary.failedProcesses} failed), ` +
      `${summary.logLines} log lines, events ${summary.events.join(" > ") || "none"}`,
  );
  console.log(
    `          peak CPU ${summary.peakCpuPct ?? "?"}%, memory ${summary.peakMemMB ?? "?"}/${summary.memTotalMB ?? "?"} MB, ` +
      `disk ${summary.peakDiskMB ?? "?"} MB` +
      (summary.killReason ? `, ended by ${summary.killReason}` : "") +
      (summary.executionMs !== null ? ` after ${(summary.executionMs / 1000).toFixed(1)}s` : ""),
  );
  if (summary.errors.length) console.log(`          missing: ${summary.errors.join("; ")}`);
}

/**
 * Credential values to mask in saved E2B logs, read from the same env names `run` uses.
 * Credentials an older run used and this env no longer has are covered by the
 * generic patterns in redactTelemetry (URL credentials, GitHub/Anthropic/E2B token shapes).
 */
function knownSecrets(apiKey: string): string[] {
  const names = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"];
  const values = names.flatMap((name) => [process.env[name], process.env[`RAVI_${name}`]]);
  return [apiKey, ...values.map((value) => value?.trim() ?? "").filter(Boolean)];
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
      description: `Task timeout in whole minutes, 1 to ${MAX_SANDBOX_TIMEOUT_MIN} (default ${DEFAULT_SANDBOX_TIMEOUT_MIN})`,
    })
    timeoutMin?: string,
    @Option({
      flags: "--keep",
      description: "Pause the sandbox instead of killing it (egress is denied first; refused with --model-auth env)",
    })
    keep?: boolean,
    @Option({
      flags: "--allow-host <host...>",
      description: "Extra hosts the worker may reach after the clone; can be repeated or comma-separated",
    })
    allowHost?: string[],
    @Option({
      flags: "--egress <mode>",
      description: `${SANDBOX_EGRESS_MODES.join("|")}: deny-all plus package registries (default), or deny-all plus --allow-host only`,
    })
    egress?: string,
    @Option({
      flags: "--model-auth <mode>",
      description: `${SANDBOX_MODEL_AUTH_MODES.join("|")}: broker when RAVI_SANDBOX_ANTHROPIC_BASE_URL is set, else header; env needs --allow-key-in-env`,
    })
    modelAuth?: string,
    @Option({
      flags: "--allow-key-in-env",
      description: "Accept that --model-auth env places the real ANTHROPIC_API_KEY in the sandbox environment",
    })
    allowKeyInEnv?: boolean,
    @Option({
      flags: "--github-auth <mode>",
      description: `${SANDBOX_GITHUB_AUTH_MODES.join("|")}: how GITHUB_TOKEN reaches the clone; header (default) is a clone-phase proxy rule, file is git's credential file inside the sandbox`,
    })
    githubAuth?: string,
    @Option({
      flags: "--output <dir>",
      description: "Where to save outputs (default ~/.ravi/sandbox-runs/<id>)",
    })
    output?: string,
    @Option({
      flags: "--follow",
      description: "Print the sandbox's daemon log live while the task runs",
    })
    follow?: boolean,
    @Option({ flags: "--json", description: "Print the run summary as JSON" })
    asJson?: boolean,
  ) {
    const flags = validateSandboxRunFlags(
      { timeoutMin, modelAuth, allowKeyInEnv, egress, allowHost, githubAuth, keep },
      asJson,
    );
    if (!repo?.trim()) fail("--repo is required.");
    const instructions = readInstructions(task, taskFile);
    validateTaskText(title ?? "Sandbox task", instructions, asJson);

    let credentials;
    try {
      credentials = resolveSandboxCredentials(process.env, flags.modelAuth);
    } catch (error) {
      fail(errorMessage(error));
    }

    let result;
    try {
      result = await runE2bSandboxTask({
        repo,
        instructions,
        title,
        branch,
        template,
        model,
        timeoutMin: flags.timeoutMin,
        keep,
        outputDir: output,
        credentials,
        allowHosts: flags.allowHosts,
        egress: flags.egress,
        githubAuth: flags.githubAuth,
        onStep: asJson ? undefined : (message) => console.log(message),
        onDaemonLog: follow && !asJson ? (line) => console.log(`  daemon | ${line}`) : undefined,
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
      if (result.e2b) printTelemetry(result.e2b);
    }
    if (result.status !== "done") process.exitCode = 1;
    return result;
  }

  @Command({
    name: "logs",
    description: "Save what E2B recorded about a sandbox: process log, lifecycle events and CPU/memory metrics",
  })
  @CommandAccess({
    kind: "read",
    resource: "sandbox",
    action: "logs",
    risk: "low",
  })
  // Writes into a host directory, like `sandbox run`.
  @CliOnly()
  @Returns(sandboxLogsReturnSchema)
  async logs(
    @Arg("sandboxId", { description: "E2B sandbox id (kept by E2B for about 7 days after it ends)" })
    sandboxId: string,
    @Option({
      flags: "--output <dir>",
      description: "Where to save them (default ~/.ravi/sandbox-runs/<id>, under e2b/)",
    })
    output?: string,
    @Option({ flags: "--json", description: "Print the summary as JSON" })
    asJson?: boolean,
  ) {
    // E2B ids are short alphanumerics; anything else would also escape ~/.ravi/sandbox-runs/.
    if (!/^[A-Za-z0-9_-]+$/.test(sandboxId ?? "")) fail(`Invalid sandbox id: ${sandboxId}`);
    let apiKey: string;
    try {
      apiKey = resolveE2bApiKey();
    } catch (error) {
      fail(errorMessage(error));
    }
    const outputDir = output ?? join(getRaviStateDir(), "sandbox-runs", sandboxId);
    let collected;
    try {
      collected = await collectE2bTelemetry({ sandboxId, apiKey, outputDir, secrets: knownSecrets(apiKey) });
    } catch (error) {
      fail(errorMessage(error));
    }
    const result = { sandboxId, outputDir, files: collected.files, e2b: collected.summary };
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printTelemetry(collected.summary);
      console.log(`Saved:    ${collected.files.map((file) => join(outputDir, file)).join("\n          ")}`);
    }
    // Any missing part (logs, events or metrics) is a failed fetch for scripts.
    if (collected.summary.errors.length > 0) process.exitCode = 1;
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

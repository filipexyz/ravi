/**
 * Sandbox Commands - run one Ravi task in a disposable cloud sandbox (E2B)
 */

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONTRACT_EXIT_USAGE, ContractError, contractDryRun, contractFail } from "../agent-contract.js";
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
  type RunSandboxTaskResult,
  type SandboxModelAuthMode,
  buildE2bTemplate,
  resolveE2bApiKey,
  resolveSandboxCredentials,
  runE2bSandboxTask,
  sandboxHostId,
  sandboxRunExitCode,
} from "../../sandbox/e2b.js";
import { collectE2bTelemetry, type E2bTelemetrySummary } from "../../sandbox/observe.js";
import { stripTerminalControls, terminalSafeJson } from "../../sandbox/outputs.js";
import { formatPatchReview } from "../../sandbox/patch-review.js";
import {
  DEFAULT_REAP_OLDER_THAN_MIN,
  type ReapDeps,
  type ReapResult,
  e2bReapDeps,
  killCandidates,
  reapSandboxes,
} from "../../sandbox/reap.js";
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

const patchReviewSchema = z.object({
  files: z.number(),
  flags: z.array(z.object({ path: z.string(), kind: z.string(), reason: z.string() })),
  suggestions: z.array(z.string()),
});
const sandboxRunReturnSchema = z.object({
  sandboxId: z.string(),
  taskId: z.string().nullable(),
  // As the sandbox reported it (unverified), or `invalid`, `timeout`, `error`, `aborted`.
  reportedStatus: z.string(),
  status: z.string(),
  review: patchReviewSchema.nullable(),
  kept: z.boolean(),
  outputDir: z.string(),
  files: z.array(z.string()),
  durationMs: z.number(),
  error: z.string().nullable(),
  e2b: e2bTelemetrySummarySchema.nullable(),
  templateId: z.string().nullable(),
  templateSha: z.string().nullable(),
  templateNote: z.string(),
});
const sandboxReapReturnSchema = z.object({
  hostId: z.string(),
  allHosts: z.boolean(),
  olderThanMin: z.number(),
  scanned: z.number(),
  candidates: z.array(
    z.object({
      sandboxId: z.string(),
      state: z.string(),
      ageMin: z.number(),
      raviHost: z.string().nullable(),
      raviRun: z.string().nullable(),
      raviPid: z.number().nullable(),
      cause: z.string(),
    }),
  ),
  skipped: z.array(z.object({ sandboxId: z.string(), cause: z.string() })),
  executed: z.boolean(),
  killed: z.array(z.string()),
  failed: z.array(z.object({ sandboxId: z.string(), error: z.string() })),
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
  buildId: z.string(),
  ref: z.string(),
  sha: z.string(),
  bunVersion: z.string(),
  natsVersion: z.string(),
  builtAt: z.string(),
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

export interface SandboxReapFlags {
  olderThan?: string;
  allHosts?: boolean;
  execute?: boolean;
  asJson?: boolean;
}

/**
 * `sandbox reap` without the E2B wiring: validates `--older-than` (usage error, exit 2),
 * lists and selects through `deps`, and either dry-runs (exit 3, nothing killed) or
 * kills with `--execute`. With no candidate there is nothing to brake, so it returns
 * the empty plan with exit 0.
 */
export async function executeSandboxReap(flags: SandboxReapFlags, hostId: string, deps: ReapDeps): Promise<ReapResult> {
  let olderThanMin = DEFAULT_REAP_OLDER_THAN_MIN;
  if (flags.olderThan?.trim()) {
    const raw = flags.olderThan.trim();
    olderThanMin = Number(raw);
    if (!/^\d+$/.test(raw) || olderThanMin < 1) {
      contractFail(
        "sandbox reap",
        "USAGE_ERROR",
        `--older-than must be a whole number of minutes, at least 1, got ${raw}.`,
        {
          asJson: flags.asJson,
          exitCode: CONTRACT_EXIT_USAGE,
          details: { suggestedAction: "Fix the flag and re-run `ravi sandbox reap`." },
        },
      );
    }
  }
  const plan = await reapSandboxes({ hostId, olderThanMin, allHosts: flags.allHosts, execute: false }, deps);
  if (plan.candidates.length === 0) return plan;
  if (flags.execute !== true) {
    contractDryRun(
      "sandbox reap",
      {
        hostId,
        allHosts: plan.allHosts,
        olderThanMin,
        kill: plan.candidates.map(({ sandboxId, state, ageMin, cause, raviHost }) => ({
          sandboxId,
          state,
          ageMin,
          cause,
          raviHost,
        })),
        skipped: plan.skipped.length,
      },
      { asJson: flags.asJson, effect: { past: "killed", verb: "kill" } },
    );
  }
  return killCandidates(plan, deps);
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

/** What E2B recorded, as printed; event names, kill reason and errors pass through stripTerminalControls. */
export function formatTelemetry(summary: E2bTelemetrySummary): string[] {
  const lines = [
    `E2B:      ${summary.processes} processes (${summary.failedProcesses} failed), ` +
      `${summary.logLines} log lines, events ${summary.events.join(" > ") || "none"}`,
    `          peak CPU ${summary.peakCpuPct ?? "?"}%, memory ${summary.peakMemMB ?? "?"}/${summary.memTotalMB ?? "?"} MB, ` +
      `disk ${summary.peakDiskMB ?? "?"} MB` +
      (summary.killReason ? `, ended by ${summary.killReason}` : "") +
      (summary.executionMs !== null ? ` after ${(summary.executionMs / 1000).toFixed(1)}s` : ""),
  ];
  if (summary.errors.length) lines.push(`          missing: ${summary.errors.join("; ")}`);
  return lines.map(stripTerminalControls);
}

function printTelemetry(summary: E2bTelemetrySummary): void {
  for (const line of formatTelemetry(summary)) console.log(line);
}

/**
 * The text summary of `sandbox run`. Every line passes through stripTerminalControls:
 * the task id, sandbox and template ids, the error and E2B's telemetry can all carry
 * what the sandbox said. The patch review box escapes control characters in paths.
 */
export function formatSandboxRunSummary(result: RunSandboxTaskResult, template: string): string[] {
  const lines = ["", `Status:   ${result.reportedStatus} (reported by the sandbox, unverified)`];
  if (result.taskId) lines.push(`Task:     ${result.taskId}`);
  lines.push(`Sandbox:  ${result.sandboxId}${result.kept ? " (paused)" : ""}`);
  // Same text as run.log: the commit only when E2B's template id is the one this host recorded.
  lines.push(`Template ${template}: ${result.templateNote}`);
  lines.push(`Outputs:  ${result.outputDir}`);
  if (result.error) lines.push(`Error:    ${result.error}`);
  if (result.e2b) lines.push(...formatTelemetry(result.e2b));
  // Advisory only: the exit code does not change (ADR 0002 #9).
  if (result.review) lines.push(...formatPatchReview(result.review, stripTerminalControls));
  return lines.map(stripTerminalControls);
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
      // C1 controls and bidi characters in sandbox-chosen strings are written as \uXXXX.
      console.log(terminalSafeJson(result));
    } else {
      for (const line of formatSandboxRunSummary(result, template ?? DEFAULT_E2B_TEMPLATE)) console.log(line);
    }
    if (sandboxRunExitCode(result) !== 0) process.exitCode = 1;
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
      console.log(terminalSafeJson(result));
    } else {
      printTelemetry(collected.summary);
      console.log(`Saved:    ${collected.files.map((file) => join(outputDir, file)).join("\n          ")}`);
    }
    // Any missing part (logs, events or metrics) is a failed fetch for scripts.
    if (collected.summary.errors.length > 0) process.exitCode = 1;
    return result;
  }

  @Command({
    name: "reap",
    description:
      "Kill orphaned task sandboxes this host created: paused, running too long or whose ravi process is gone (dry-run by default)",
  })
  @CommandAccess({
    kind: "mutate",
    resource: "sandbox",
    action: "reap",
    risk: "high",
    requiresConfirmation: true,
  })
  // Reads this host's installation key and process table, like `sandbox run`.
  @CliOnly()
  @Returns(sandboxReapReturnSchema)
  async reap(
    @Option({
      flags: "--older-than <minutes>",
      description: `Running sandboxes older than this are orphans (default ${DEFAULT_REAP_OLDER_THAN_MIN}: the longest run plus a margin)`,
    })
    olderThan?: string,
    @Option({
      flags: "--all-hosts",
      description: "Also consider ravi-task sandboxes other hosts created (paused or overdue only)",
    })
    allHosts?: boolean,
    @Option({ flags: "--execute", description: "Kill the candidates; the default is a dry-run (exit 3)" })
    execute?: boolean,
    @Option({ flags: "--json", description: "Print the plan or result as JSON" })
    asJson?: boolean,
  ) {
    let apiKey: string;
    try {
      apiKey = resolveE2bApiKey();
    } catch (error) {
      fail(errorMessage(error));
    }
    let result: ReapResult;
    try {
      result = await executeSandboxReap({ olderThan, allHosts, execute, asJson }, sandboxHostId(), e2bReapDeps(apiKey));
    } catch (error) {
      if (error instanceof ContractError) throw error;
      fail(errorMessage(error));
    }
    if (asJson) {
      console.log(terminalSafeJson(result));
    } else if (result.candidates.length === 0) {
      console.log(
        `No sandboxes to reap (${result.scanned} ravi-task sandbox(es) seen, ${result.skipped.length} skipped).`,
      );
    } else {
      for (const candidate of result.candidates) {
        const outcome = result.killed.includes(candidate.sandboxId)
          ? "killed"
          : (result.failed.find((f) => f.sandboxId === candidate.sandboxId)?.error ?? "not killed");
        console.log(
          `${candidate.sandboxId}  ${candidate.state}  ${candidate.ageMin} min  ${candidate.cause}  -> ${outcome}`,
        );
      }
    }
    if (result.failed.length > 0) process.exitCode = 1;
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
      description: `Ravi branch, tag or 40-hex commit baked into the template (default ${DEFAULT_E2B_TEMPLATE_REF}); resolved to a SHA on this host`,
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
        console.log(terminalSafeJson(result));
      } else {
        console.log(
          `\nTemplate ready: ${result.name} (id ${result.templateId}, build ${result.buildId}, ` +
            `ravi ${result.sha} from ${result.ref}, bun ${result.bunVersion}, nats-server ${result.natsVersion})`,
        );
      }
      return result;
    } catch (error) {
      fail(errorMessage(error));
    }
  }
}

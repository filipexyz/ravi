/**
 * E2B sandbox runner — executes one Ravi task inside a disposable E2B microVM.
 *
 * The template (built once with buildE2bTemplate) holds Bun, nats-server and a
 * built Ravi checkout. Its start command launches nats-server, so the memory
 * snapshot E2B takes at the end of the build already has NATS listening when a
 * sandbox boots from it.
 *
 * runE2bSandboxTask: create sandbox -> clone the repo -> start the Ravi daemon
 * with this task's credentials -> create a Claude-backed worker agent whose cwd
 * is the clone -> create and dispatch the task -> poll until done/failed/blocked
 * -> save TASK.md, task.json, the git patch, the daemon log, Ravi's session
 * traces and the Claude transcripts locally -> kill the sandbox (or pause it when
 * keep is set) -> save what E2B recorded about it (logs, events, metrics).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import {
  type CollectE2bTelemetryOptions,
  type E2bTelemetrySummary,
  collectE2bTelemetry,
  redactSecrets,
} from "./observe.js";

export const DEFAULT_E2B_TEMPLATE = "ravi-runner";
export const DEFAULT_E2B_TEMPLATE_REF = "dev";
export const DEFAULT_SANDBOX_MODEL = "sonnet";
export const DEFAULT_SANDBOX_TIMEOUT_MIN = 55;

const RAVI_REPO = "https://github.com/filipexyz/ravi.git";
const NATS_VERSION = "2.11.8";
const TEMPLATE_RAVI_DIR = "/home/user/ravi";
const REPO_DIR = "/home/user/work/repo";
const DAEMON_LOG = "/home/user/.ravi/daemon.log";
const CLAUDE_PROJECTS_DIR = "/home/user/.claude/projects";
const MAX_TRANSCRIPTS = 50;
const TERMINAL_STATUSES = new Set(["done", "failed", "blocked"]);
const CLAUDE_CREDENTIAL_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] as const;
const CLONE_TIMEOUT_MS = 10 * 60_000;
// GITHUB_TOKEN reaches git through this file, never a command line or a per-command
// env var: E2B logs both (args and envs) and keeps those logs for days. File writes
// are logged by path only.
const GIT_CREDENTIALS_FILE = "/home/user/.ravi-clone-credentials";
const SIGNAL_CLEANUP_TIMEOUT_MS = 15_000;

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

export interface SandboxCredentials {
  e2bApiKey: string;
  /** Claude credentials passed into the sandbox under the names Claude Code reads. */
  agentEnv: Record<string, string>;
  githubToken?: string;
}

/**
 * Resolve credentials from the environment. Claude Code on the web hides
 * CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY from sessions, so the
 * RAVI_-prefixed names are accepted as well.
 */
export function resolveE2bApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.E2B_API_KEY?.trim();
  if (!apiKey) throw new SandboxConfigError("E2B_API_KEY is not configured.");
  return apiKey;
}

export function resolveSandboxCredentials(env: NodeJS.ProcessEnv = process.env): SandboxCredentials {
  const e2bApiKey = resolveE2bApiKey(env);

  const agentEnv: Record<string, string> = {};
  for (const key of CLAUDE_CREDENTIAL_KEYS) {
    const value = (env[key] || env[`RAVI_${key}`])?.trim();
    if (value) agentEnv[key] = value;
  }
  if (Object.keys(agentEnv).length === 0) {
    throw new SandboxConfigError(
      "Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY (or RAVI_CLAUDE_CODE_OAUTH_TOKEN / RAVI_ANTHROPIC_API_KEY).",
    );
  }

  const githubToken = env.GITHUB_TOKEN?.trim() || undefined;
  return { e2bApiKey, agentEnv, githubToken };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** GITHUB_TOKEN is only ever sent to github.com over https. */
export function githubCloneAuth(repo: string, token?: string): { username: string; password: string } | null {
  if (!token) return null;
  try {
    const url = new URL(repo);
    if (url.protocol === "https:" && url.hostname === "github.com")
      return { username: "x-access-token", password: token };
  } catch {
    // Not a URL (e.g. scp-style git@host:path); never attach the token.
  }
  return null;
}

/**
 * What to clone and the credential line git reads from the credential file, if any.
 * Credentials embedded in an http(s) URL move to that file too, so they never reach
 * a command line, which E2B logs. Otherwise GITHUB_TOKEN applies (github.com only).
 */
export function resolveCloneSource(
  repo: string,
  githubToken?: string,
): { url: string; credentialLine: string | null; urlPassword: string | null } {
  try {
    const parsed = new URL(repo);
    if ((parsed.protocol === "https:" || parsed.protocol === "http:") && (parsed.username || parsed.password)) {
      // username/password come back percent-encoded, which is what git's store file expects.
      const credentialLine = `${parsed.protocol}//${parsed.username}:${parsed.password}@${parsed.host}\n`;
      const urlPassword = parsed.password ? decodeURIComponent(parsed.password) : null;
      parsed.username = "";
      parsed.password = "";
      return { url: parsed.toString(), credentialLine, urlPassword };
    }
  } catch {
    // Not a URL (e.g. scp-style git@host:path): nothing to move.
  }
  const auth = githubCloneAuth(repo, githubToken);
  return {
    url: repo,
    credentialLine: auth ? `https://${auth.username}:${encodeURIComponent(auth.password)}@github.com\n` : null,
    urlPassword: null,
  };
}

/** Turn an E2B CommandExitError into an error that says which command failed and why. */
export function describeCommandError(cmd: string, err: unknown): Error {
  if (err && typeof err === "object" && "exitCode" in err) {
    const { exitCode, stderr } = err as { exitCode?: number; stderr?: string };
    const label = cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd;
    const tail = (stderr ?? "").trim().split("\n").slice(-20).join("\n");
    return new Error(`\`${label}\` exited with code ${exitCode}${tail ? `: ${tail}` : ""}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Template

export interface BuildE2bTemplateOptions {
  name?: string;
  ref?: string;
  cpu?: number;
  memoryMB?: number;
  apiKey: string;
  onLog?: (line: string) => void;
}

export interface BuildE2bTemplateResult {
  name: string;
  templateId: string;
  ref: string;
  durationMs: number;
}

export async function buildE2bTemplate(options: BuildE2bTemplateOptions): Promise<BuildE2bTemplateResult> {
  const { Template, waitForPort } = await import("e2b");
  const name = options.name ?? DEFAULT_E2B_TEMPLATE;
  const ref = options.ref ?? DEFAULT_E2B_TEMPLATE_REF;
  const natsTarball = `nats-server-v${NATS_VERSION}-linux-amd64`;
  // Agent Bash tools call `ravi` by name, so it has to be on the default PATH.
  const raviWrapper = `#!/usr/bin/env bash\nexport RAVI_ALLOW_STALE_BUNDLE=1\nexec ${TEMPLATE_RAVI_DIR}/bin/ravi "$@"\n`;

  const template = Template()
    .fromBaseImage()
    .aptInstall(["git", "curl", "unzip", "ca-certificates", "jq"])
    .runCmd(
      [
        `curl -fsSL https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/${natsTarball}.tar.gz | tar xz -C /tmp`,
        `mv /tmp/${natsTarball}/nats-server /usr/local/bin/nats-server`,
      ],
      { user: "root" },
    )
    .runCmd("curl -fsSL https://bun.sh/install | bash")
    // bun must be on PATH before building: Ravi's prebuild script calls it by name.
    .runCmd(
      [
        "ln -sf /home/user/.bun/bin/bun /usr/local/bin/bun",
        `printf '%s' ${shellQuote(raviWrapper)} > /usr/local/bin/ravi && chmod +x /usr/local/bin/ravi`,
      ],
      { user: "root" },
    )
    // Without this E2B reuses the cached clone layer and a rebuild never picks up
    // new commits on the ref. Everything from here on (install, build) reruns.
    .skipCache()
    .gitClone(RAVI_REPO, TEMPLATE_RAVI_DIR, { branch: ref, depth: 1 })
    .runCmd(`cd ${TEMPLATE_RAVI_DIR} && bun install --frozen-lockfile && bun run build`)
    .runCmd("mkdir -p /home/user/.ravi/jetstream /home/user/work")
    .setStartCmd("nats-server -js -sd /home/user/.ravi/jetstream -a 127.0.0.1 -p 4222", waitForPort(4222));

  const startedAt = Date.now();
  const info = await Template.build(template, name, {
    apiKey: options.apiKey,
    cpuCount: options.cpu ?? 2,
    memoryMB: options.memoryMB ?? 4096,
    onBuildLogs: options.onLog ? (entry) => options.onLog?.(String(entry.message ?? entry)) : undefined,
  });
  return {
    name: info.name ?? name,
    templateId: info.templateId,
    ref,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Task run

/** The slice of the E2B Sandbox API the runner uses; tests pass a fake. */
export interface SandboxHandle {
  sandboxId: string;
  commands: {
    run(
      cmd: string,
      opts?: { timeoutMs?: number; background?: boolean; onStdout?: (data: string) => void },
    ): Promise<{ stdout?: string; stderr?: string; exitCode?: number; disconnect?: () => Promise<unknown> }>;
  };
  files: {
    write(path: string, data: string): Promise<unknown>;
  };
  kill(): Promise<unknown>;
  pause(): Promise<unknown>;
}

export interface CreateSandboxInput {
  template: string;
  apiKey: string;
  timeoutMs: number;
  envs: Record<string, string>;
  metadata: Record<string, string>;
}

export interface RunSandboxTaskOptions {
  repo: string;
  instructions: string;
  title?: string;
  branch?: string;
  template?: string;
  model?: string;
  timeoutMin?: number;
  keep?: boolean;
  outputDir?: string;
  credentials: SandboxCredentials;
  onStep?: (message: string) => void;
  pollIntervalMs?: number;
  createSandbox?: (input: CreateSandboxInput) => Promise<SandboxHandle>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after Ctrl-C/SIGTERM cleanup; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Receives each daemon log line as it is written inside the sandbox. */
  onDaemonLog?: (line: string) => void;
  /** Fetches E2B's logs, events and metrics after the sandbox ends; tests pass a fake. */
  collectTelemetry?: (
    options: CollectE2bTelemetryOptions,
  ) => Promise<{ summary: E2bTelemetrySummary; files: string[] } | null>;
}

export interface RunSandboxTaskResult {
  sandboxId: string;
  taskId: string | null;
  status: string;
  kept: boolean;
  outputDir: string;
  files: string[];
  durationMs: number;
  error: string | null;
  /** What E2B recorded about the sandbox (null when it could not be fetched). */
  e2b: E2bTelemetrySummary | null;
}

/** File name for a session or transcript path, safe on any filesystem. */
export function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "") || "unnamed";
}

async function createE2bSandbox(input: CreateSandboxInput): Promise<SandboxHandle> {
  const { Sandbox } = await import("e2b");
  return (await Sandbox.create(input.template, {
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    envs: input.envs,
    metadata: input.metadata,
  })) as unknown as SandboxHandle;
}

export async function runE2bSandboxTask(options: RunSandboxTaskOptions): Promise<RunSandboxTaskResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const secrets = [
    options.credentials.e2bApiKey,
    ...Object.values(options.credentials.agentEnv),
    ...(options.credentials.githubToken ? [options.credentials.githubToken] : []),
  ];
  // Every step also goes to run.log; lines before the output dir exists are buffered.
  let runLog: string | null = null;
  const pendingRunLog: string[] = [];
  const step = (message: string) => {
    const line = `[${((now() - startedAt) / 1000).toFixed(1)}s] ${message}`;
    options.onStep?.(line);
    if (!runLog) {
      pendingRunLog.push(line);
      return;
    }
    try {
      appendFileSync(runLog, `${redactSecrets(line, secrets)}\n`);
    } catch {
      // A failed diagnostic write must never stand between the run and the sandbox's cleanup.
    }
  };
  const template = options.template ?? DEFAULT_E2B_TEMPLATE;
  const title = options.title ?? "Sandbox task";
  const timeoutMs = (options.timeoutMin ?? DEFAULT_SANDBOX_TIMEOUT_MIN) * 60_000;

  step(`Creating sandbox from ${template}`);
  const sandbox = await (options.createSandbox ?? createE2bSandbox)({
    template,
    apiKey: options.credentials.e2bApiKey,
    // Sandbox lifetime; the task poll below stops a little earlier.
    timeoutMs: timeoutMs + 5 * 60_000,
    envs: { ...options.credentials.agentEnv, RAVI_ALLOW_STALE_BUNDLE: "1" },
    metadata: { purpose: "ravi-task", title },
  });
  step(`Sandbox ${sandbox.sandboxId} is up`);

  const outputDir = options.outputDir ?? join(getRaviStateDir(), "sandbox-runs", sandbox.sandboxId);
  const files: string[] = [];
  try {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, "run.log"),
      pendingRunLog.map((line) => `${redactSecrets(line, secrets)}\n`).join(""),
    );
  } catch (err) {
    // Don't leave a billable, credential-holding sandbox running until its timeout.
    await sandbox.kill().catch(() => {});
    throw err;
  }
  runLog = join(outputDir, "run.log");
  files.push("run.log");

  // Ctrl-C or SIGTERM must not leave a billable, credential-holding sandbox running.
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const onSignal = (signal: NodeJS.Signals) => {
    step(
      `${signal} received, ${options.keep ? "pausing" : "killing"} sandbox ${sandbox.sandboxId}; ` +
        `\`ravi sandbox logs ${sandbox.sandboxId}\` fetches what E2B recorded`,
    );
    const cleanup = options.keep ? sandbox.pause() : sandbox.kill();
    const limit = new Promise((resolve) => setTimeout(resolve, SIGNAL_CLEANUP_TIMEOUT_MS).unref?.());
    void Promise.race([cleanup, limit])
      .catch(() => {})
      .finally(() => exit(signal === "SIGINT" ? 130 : 143));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const run = async (cmd: string, cmdTimeoutMs = 120_000) => {
    try {
      return (await sandbox.commands.run(cmd, { timeoutMs: cmdTimeoutMs })).stdout ?? "";
    } catch (err) {
      throw describeCommandError(cmd, err);
    }
  };
  const sh = async (cmd: string, cmdTimeoutMs?: number) => (await run(cmd, cmdTimeoutMs)).trim();

  // Tree of the clone's working copy (untracked files included), written with a
  // throwaway index so the worker's view of `git status` is left untouched.
  const worktreeTreeCmd =
    `(cd ${REPO_DIR} && tmp=$(mktemp) && cp .git/index "$tmp" && GIT_INDEX_FILE="$tmp" git add -A && ` +
    `GIT_INDEX_FILE="$tmp" git write-tree; rc=$?; rm -f "$tmp"; exit $rc)`;
  // Set once Ravi has scaffolded the worker's cwd, so the patch holds only the
  // task's changes (committed or not) and not Ravi's AGENTS.md/CLAUDE.md files.
  let baselineTree: string | null = null;

  // The daemon log is copied as it is written, so a sandbox that dies mid-run
  // still leaves its log behind; the full file replaces the copy at the end.
  const daemonLogPath = join(outputDir, "daemon.log");
  let daemonTail: { disconnect?: () => Promise<unknown> } | null = null;
  let partialLine = "";
  const onDaemonChunk = (chunk: string) => {
    const lines = (partialLine + chunk).split("\n");
    partialLine = lines.pop() ?? "";
    if (lines.length === 0) return;
    const redacted = lines.map((line) => redactSecrets(line, secrets));
    try {
      appendFileSync(daemonLogPath, redacted.map((line) => `${line}\n`).join(""));
    } catch {
      // The full log is read again at the end; losing the live copy is not fatal.
    }
    for (const line of redacted) options.onDaemonLog?.(line);
  };

  const collectOutputs = async (taskId: string | null) => {
    const grab = async (name: string, cmd: string, raw = false, keepOnFailure = false) => {
      let content: string;
      try {
        // The patch is written byte for byte; trimming would corrupt it.
        content = raw ? await run(cmd, 300_000) : `${await sh(cmd, 300_000)}\n`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (keepOnFailure && existsSync(join(outputDir, name))) {
          // Keep the last line the daemon wrote even if it never got its newline.
          const unfinished = partialLine ? `${redactSecrets(partialLine, secrets)}\n` : "";
          appendFileSync(
            join(outputDir, name),
            `${unfinished}(log copied live; full read failed: ${redactSecrets(message, secrets)})\n`,
          );
          files.push(name);
          return;
        }
        content = `(failed: ${message})\n`;
      }
      mkdirSync(dirname(join(outputDir, name)), { recursive: true });
      writeFileSync(join(outputDir, name), redactSecrets(content, secrets));
      files.push(name);
    };
    // Stop streaming but leave `tail` running: killing it would show up as a failed process in E2B's log.
    await daemonTail?.disconnect?.().catch(() => {});
    daemonTail = null;
    await grab("daemon.log", `cat ${DAEMON_LOG}`, true, true);
    await grab(
      "changes.patch",
      `cur=$( ${worktreeTreeCmd} ) && cd ${REPO_DIR} && git diff --binary ${baselineTree ?? "HEAD"} "$cur"`,
      true,
    );
    if (taskId) {
      await grab("task.json", `ravi tasks show ${taskId} --json`);
      await grab("TASK.md", `cat /home/user/.ravi/tasks/${taskId}/TASK.md`);
    }
    if (!daemonStarted) return;

    // Ravi's own timeline per session: prompts, turns, tool calls, deliveries, errors.
    // The task's own work session can be gone from `sessions list` once the task
    // ends, but its trace stays, so take its name from task.json as well.
    const sessionNames: string[] = [];
    try {
      const taskJson = taskId ? readFileSync(join(outputDir, "task.json"), "utf8") : "";
      for (const match of taskJson.matchAll(/"sessionName"\s*:\s*"([^"]+)"/g)) sessionNames.push(match[1]);
    } catch {
      // No task.json; the session list below still applies.
    }
    try {
      const listed = JSON.parse(await sh("ravi sessions list --json --limit 500")) as {
        items?: Array<{ name?: string; sessionKey?: string }>;
        sessions?: Array<{ name?: string; sessionKey?: string }>;
      };
      for (const session of listed.items ?? listed.sessions ?? []) {
        const name = session.name ?? session.sessionKey;
        if (name) sessionNames.push(name);
      }
    } catch (error) {
      step(`Could not list sessions: ${error instanceof Error ? error.message : error}`);
    }
    for (const name of new Set(sessionNames)) {
      const base = `sessions/${safeFileName(name)}`;
      await grab(`${base}.trace.txt`, `ravi sessions trace ${shellQuote(name)} --explain`);
      await grab(`${base}.trace.jsonl`, `ravi sessions trace ${shellQuote(name)} --json`, true);
    }

    // Claude Code's own transcripts: every message, tool call and tool result.
    let transcripts: string[] = [];
    try {
      transcripts = (await sh(`find ${CLAUDE_PROJECTS_DIR} -name '*.jsonl' -type f 2>/dev/null | sort`))
        .split("\n")
        .filter(Boolean);
    } catch {
      transcripts = [];
    }
    for (const path of transcripts.slice(0, MAX_TRANSCRIPTS)) {
      const relative = path.slice(CLAUDE_PROJECTS_DIR.length + 1);
      const name = relative.split("/").map(safeFileName).join("/");
      await grab(`transcripts/${name}`, `cat ${shellQuote(path)}`, true);
    }
    if (transcripts.length > MAX_TRANSCRIPTS) {
      step(`Saved ${MAX_TRANSCRIPTS} of ${transcripts.length} transcripts`);
    }
  };

  let taskId: string | null = null;
  let daemonStarted = false;
  let status = "unknown";
  let error: string | null = null;
  try {
    await sh(
      "timeout 5 bash -c '</dev/tcp/127.0.0.1/4222' || (echo 'nats-server is not listening' >&2; exit 1)",
      10_000,
    );
    step("NATS already listening (restored from snapshot)");

    const githubToken = options.credentials.githubToken;
    const source = resolveCloneSource(options.repo, githubToken);
    if (source.urlPassword) secrets.push(source.urlPassword);
    step(`Cloning ${source.url}`);
    const branchArgs = options.branch ? `--branch ${shellQuote(options.branch)} --single-branch ` : "";
    const cloneArgs = `clone --depth 50 ${branchArgs}${shellQuote(source.url)} ${REPO_DIR}`;
    let cloneCmd = `git ${cloneArgs}`;
    if (source.credentialLine) {
      await sandbox.files.write(GIT_CREDENTIALS_FILE, source.credentialLine);
      // `git -c` applies to this clone only; the file is removed whatever the outcome.
      cloneCmd =
        `git -c credential.helper=${shellQuote(`store --file=${GIT_CREDENTIALS_FILE}`)} ${cloneArgs}; ` +
        `rc=$?; rm -f ${GIT_CREDENTIALS_FILE}; exit $rc`;
    }
    try {
      await run(`GIT_TERMINAL_PROMPT=0 ${cloneCmd}`, CLONE_TIMEOUT_MS);
    } catch (err) {
      if (source.credentialLine) await run(`rm -f ${GIT_CREDENTIALS_FILE}`).catch(() => {});
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), secrets));
    }
    // Ravi writes .claude/settings.json into the agent cwd; keep it out of the
    // patch unless the repo already tracks that file.
    await sh(`echo .claude/settings.json >> ${REPO_DIR}/.git/info/exclude`);

    step("Starting Ravi daemon");
    await sandbox.commands.run(`ravi daemon run </dev/null > ${DAEMON_LOG} 2>&1`, { background: true, timeoutMs: 0 });
    daemonStarted = true;
    try {
      daemonTail = await sandbox.commands.run(`tail -n +1 -F ${DAEMON_LOG} 2>/dev/null`, {
        background: true,
        timeoutMs: 0,
        onStdout: onDaemonChunk,
      });
    } catch (err) {
      // Only the live copy is lost; the full log is still read at the end.
      step(`Live daemon log unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sh(
      `for i in $(seq 1 60); do grep -q 'Daemon ready' ${DAEMON_LOG} && exit 0; sleep 1; done; ` +
        `tail -20 ${DAEMON_LOG} >&2; exit 1`,
      90_000,
    );
    step("Daemon ready");

    // The default runtime provider is codex; sandbox tasks run on Claude.
    const model = options.model ?? DEFAULT_SANDBOX_MODEL;
    await sh(`ravi agents create worker ${REPO_DIR} --provider claude --model ${shellQuote(model)}`);
    await sh("ravi agents permissions worker full-access --execute");
    baselineTree = await sh(worktreeTreeCmd);
    // `tasks create` outside a Ravi session needs an existing session to report to.
    await sh("ravi agents create operator /home/user/work --provider claude --model haiku");
    await sh('ravi sessions send -a operator operator "Operator inbox for sandbox task reports. Reply OK."');

    step("Creating and dispatching the task");
    const created = JSON.parse(
      await sh(
        `ravi tasks create ${shellQuote(title)} --instructions ${shellQuote(options.instructions)} ` +
          "--agent worker --report-to operator --json",
      ),
    ) as { task?: { id?: string } };
    taskId = created.task?.id ?? null;
    if (!taskId) throw new Error("ravi tasks create did not return a task id");
    step(`Task ${taskId} dispatched`);

    const deadline = startedAt + timeoutMs;
    let lastLine = "";
    while (now() < deadline) {
      const shown = JSON.parse(await sh(`ravi tasks show ${taskId} --json`)) as {
        task?: { status?: string; progress?: number };
        status?: string;
        progress?: number;
      };
      const task = shown.task ?? shown;
      const line = `status=${task.status} progress=${task.progress ?? 0}`;
      if (line !== lastLine) {
        step(line);
        lastLine = line;
      }
      if (task.status && TERMINAL_STATUSES.has(task.status)) {
        status = task.status;
        break;
      }
      await sleep(options.pollIntervalMs ?? 10_000);
    }
    if (status === "unknown") {
      status = "timeout";
      step("Timed out waiting for the task");
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
    step(`Error: ${error}`);
  }

  try {
    await collectOutputs(taskId);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    try {
      if (options.keep) {
        await sandbox.pause();
        step(`Sandbox ${sandbox.sandboxId} paused`);
      } else {
        await sandbox.kill();
        step("Sandbox killed");
      }
    } catch (err) {
      // Keep the collected result; report the lifecycle failure alongside it.
      const message = `Failed to ${options.keep ? "pause" : "kill"} sandbox: ${err instanceof Error ? err.message : String(err)}`;
      error = error ? `${error}; ${message}` : message;
      step(message);
    }
  }

  // E2B keeps these after the sandbox is gone, including why it ended.
  let e2b: E2bTelemetrySummary | null = null;
  try {
    const collected = await (options.collectTelemetry ?? collectE2bTelemetry)({
      sandboxId: sandbox.sandboxId,
      apiKey: options.credentials.e2bApiKey,
      outputDir,
      secrets,
      waitForEnd: true,
    });
    if (collected) {
      e2b = collected.summary;
      files.push(...collected.files);
      step(
        `E2B: ${e2b.processes} processes (${e2b.failedProcesses} failed), ` +
          `peak CPU ${e2b.peakCpuPct ?? "?"}%, peak memory ${e2b.peakMemMB ?? "?"}/${e2b.memTotalMB ?? "?"} MB` +
          (e2b.killReason ? `, ended by ${e2b.killReason}` : "") +
          (e2b.errors.length ? ` (missing: ${e2b.errors.join("; ")})` : ""),
      );
    }
  } catch (err) {
    step(`Could not fetch E2B logs: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    sandboxId: sandbox.sandboxId,
    taskId,
    status,
    kept: Boolean(options.keep),
    outputDir,
    files,
    durationMs: now() - startedAt,
    error,
    e2b,
  };
}

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

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readOrCreateInstallationKey } from "../cloud-auth/installation-key.js";
import { writeUserOnlyFile } from "../cloud-auth/secret-backends.js";
import { classifyAnthropicSecretShape } from "../runtime/credential-secret-shape.js";
import { getRaviStateDir } from "../utils/paths.js";
import {
  type CollectE2bTelemetryOptions,
  type E2bTelemetrySummary,
  SANDBOX_PLACEHOLDER_API_KEY,
  collectE2bTelemetry,
  redactSecrets,
} from "./observe.js";
import {
  MAX_COMMAND_OUTPUT,
  MAX_DAEMON_LINE,
  MAX_DAEMON_LOG,
  MAX_JSON,
  MAX_PATCH,
  MAX_TOTAL,
  MAX_TRANSCRIPT,
  STREAM_MARGIN,
  appendPrivate,
  cappedCommand,
  formatBytes,
  mkdirPrivate,
  readCapped,
  stripTerminalControls,
  truncationMarker,
  writePrivate,
} from "./outputs.js";
import { type PatchReview, reviewPatch } from "./patch-review.js";

export { SANDBOX_PLACEHOLDER_API_KEY };

export const DEFAULT_E2B_TEMPLATE = "ravi-runner";
export const DEFAULT_E2B_TEMPLATE_REF = "dev";
export const DEFAULT_SANDBOX_MODEL = "sonnet";
export const DEFAULT_SANDBOX_TIMEOUT_MIN = 55;
/** E2B Hobby caps a sandbox at 1 h; the sandbox lives 5 min longer than the task, so 55 + 5 fits. */
export const MAX_SANDBOX_TIMEOUT_MIN = 55;
/** Same value the e2b package exports; mirrored so the pure network builder never loads the SDK. */
export const ALL_TRAFFIC = "0.0.0.0/0";
export const ANTHROPIC_API_HOST = "api.anthropic.com";
export const SANDBOX_MODEL_AUTH_MODES = ["broker", "header", "env"] as const;
export type SandboxModelAuthMode = (typeof SANDBOX_MODEL_AUTH_MODES)[number];
export const SANDBOX_EGRESS_MODES = ["dev-registries", "strict"] as const;
export type SandboxEgressMode = (typeof SANDBOX_EGRESS_MODES)[number];
/**
 * How GITHUB_TOKEN reaches the clone: `header` (default) as a secret-store placeholder
 * in a clone-phase transform rule, `file` through git's credential file (#623), which
 * also forces that path when the proxy's rule is not being honoured.
 */
export const SANDBOX_GITHUB_AUTH_MODES = ["header", "file"] as const;
export type SandboxGithubAuthMode = (typeof SANDBOX_GITHUB_AUTH_MODES)[number];
/** Title and instructions together; checked on the host before anything is created. */
export const MAX_TASK_TEXT_BYTES = 100 * 1024;
/**
 * Hosts a coding task needs to install dependencies and run tests. They serve fixed
 * content and publishing to any of them needs credentials the sandbox does not
 * have, so they are poor exfiltration targets. GOPROXY (`proxy.golang.org`) is left
 * out on purpose: it fetches arbitrary module origins on demand, so a request for
 * `attacker.tld/<payload>` reaches the attacker through an allowlisted host. Go
 * users add it with `--allow-host proxy.golang.org`; `--egress strict` drops the
 * whole preset.
 */
export const DEV_REGISTRY_HOSTS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "rubygems.org",
  "index.rubygems.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;

export const RAVI_REPO = "https://github.com/filipexyz/ravi.git";
/**
 * Toolchain the template installs, pinned by version and SHA-256 so a rebuild cannot
 * silently pick up a different binary. The digests are copied from the publishers'
 * checksum files (provenance in .ravi/specs/sandbox/e2b-runs/RUNBOOK.md), never computed
 * from a download here. Bun matches CI (.github/workflows/ci.yml).
 */
export const TEMPLATE_BUN_VERSION = "1.3.11";
export const TEMPLATE_BUN_LINUX_X64_SHA256 = "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed";
export const NATS_VERSION = "2.11.8";
export const NATS_LINUX_AMD64_SHA256 = "397a6deffb5533e160de0cca322bc3dcaec7fb7282d66a3dfa87a9c183152ad1";
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const TEMPLATE_RAVI_DIR = "/home/user/ravi";
const REPO_DIR = "/home/user/work/repo";
const DAEMON_LOG = "/home/user/.ravi/daemon.log";
const CLAUDE_PROJECTS_DIR = "/home/user/.claude/projects";
const MAX_TRANSCRIPTS = 50;
const TERMINAL_STATUSES = new Set(["done", "failed", "blocked"]);
/**
 * A task id as `dbCreateTask` makes it (src/tasks/task-db.ts: `task-` and 8 hex digits of a
 * UUID). The id comes back from the sandbox and is used in commands, paths and printed
 * lines, so anything else fails the run.
 */
export const TASK_ID_RE = /^task-[0-9a-f]{8}$/;
/** `TaskStatus` (src/tasks/types.ts); anything else the sandbox reports is `invalid`. */
export const TASK_STATUSES = ["open", "dispatched", "in_progress", "blocked", "done", "failed"] as const;
/** What `ravi tasks show --json` may look like; the fields the run reads, nothing trusted beyond them. */
const taskShowSchema = z.object({
  task: z.object({ status: z.enum(TASK_STATUSES), progress: z.number().finite().optional() }).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  progress: z.number().finite().optional(),
});
const CLONE_TIMEOUT_MS = 10 * 60_000;
// Title and instructions reach `ravi tasks create` through these files and `$(cat …)`:
// E2B logs every command string and keeps the logs for days, and task text may hold
// anything from customer data to shell metacharacters.
const TASK_TEXT_DIR = "/home/user/.ravi-task";
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

/**
 * How the worker's Claude Code reaches the model. Sandboxes take an Anthropic API
 * key only, never a subscription (OAuth) token.
 * - `broker`: requests go to a Ravi broker (`RAVI_SANDBOX_ANTHROPIC_BASE_URL`); the
 *   sandbox holds the placeholder key and `headers` (the grant, filled in by connected
 *   runs) are added by E2B's egress proxy on that host only.
 * - `header`: the real key lives in E2B's secret store for the run and is injected as
 *   `x-api-key` on api.anthropic.com; the sandbox env holds the placeholder.
 * - `env`: legacy; the real key is in the sandbox env, where E2B logs and `--keep`
 *   snapshots can see it. Explicit opt-in only.
 */
export type SandboxModelAuth =
  | { mode: "broker"; baseUrl: string; headers?: Record<string, string> }
  | { mode: "header"; apiKey: string }
  | { mode: "env"; apiKey: string };

export interface SandboxCredentials {
  e2bApiKey: string;
  modelAuth: SandboxModelAuth;
  githubToken?: string;
}

/**
 * Resolve credentials from the environment. Claude Code on the web hides
 * ANTHROPIC_API_KEY from sessions, so the RAVI_-prefixed name is accepted as well.
 */
export function resolveE2bApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.E2B_API_KEY?.trim();
  if (!apiKey) throw new SandboxConfigError("E2B_API_KEY is not configured.");
  return apiKey;
}

const OAUTH_REFUSED =
  "Sandboxes take an Anthropic API key only (ANTHROPIC_API_KEY or RAVI_ANTHROPIC_API_KEY). " +
  "CLAUDE_CODE_OAUTH_TOKEN is a subscription token: it is not scoped to one run, cannot be " +
  "injected per host and would sit in a machine E2B can snapshot, so it is refused.";

/**
 * Model auth defaults to `broker` when RAVI_SANDBOX_ANTHROPIC_BASE_URL is set and to
 * `header` otherwise. `env` is never chosen implicitly.
 */
export function resolveSandboxCredentials(
  env: NodeJS.ProcessEnv = process.env,
  modelAuthMode?: SandboxModelAuthMode,
): SandboxCredentials {
  const e2bApiKey = resolveE2bApiKey(env);
  const brokerUrl = env.RAVI_SANDBOX_ANTHROPIC_BASE_URL?.trim();
  const mode = modelAuthMode ?? (brokerUrl ? "broker" : "header");

  let modelAuth: SandboxModelAuth;
  if (mode === "broker") {
    if (!brokerUrl) throw new SandboxConfigError("Model auth `broker` needs RAVI_SANDBOX_ANTHROPIC_BASE_URL.");
    let parsed: URL;
    try {
      parsed = new URL(brokerUrl);
    } catch {
      throw new SandboxConfigError(`RAVI_SANDBOX_ANTHROPIC_BASE_URL is not a URL: ${brokerUrl}`);
    }
    if (parsed.protocol !== "https:") {
      throw new SandboxConfigError(
        "RAVI_SANDBOX_ANTHROPIC_BASE_URL must be https: the sandbox sends model traffic to it.",
      );
    }
    modelAuth = { mode, baseUrl: brokerUrl };
  } else {
    const apiKey = (env.ANTHROPIC_API_KEY || env.RAVI_ANTHROPIC_API_KEY)?.trim();
    const oauthToken = (env.CLAUDE_CODE_OAUTH_TOKEN || env.RAVI_CLAUDE_CODE_OAUTH_TOKEN)?.trim();
    if (!apiKey) {
      if (oauthToken) throw new SandboxConfigError(OAUTH_REFUSED);
      throw new SandboxConfigError("Set ANTHROPIC_API_KEY (or RAVI_ANTHROPIC_API_KEY).");
    }
    if (classifyAnthropicSecretShape(apiKey) === "oauth") throw new SandboxConfigError(OAUTH_REFUSED);
    modelAuth = { mode, apiKey };
  }

  const githubToken = env.GITHUB_TOKEN?.trim() || undefined;
  return { e2bApiKey, modelAuth, githubToken };
}

/** Every credential value a run holds, for log redaction. */
export function sandboxSecretValues(credentials: SandboxCredentials): string[] {
  const { modelAuth } = credentials;
  return [
    credentials.e2bApiKey,
    ...(modelAuth.mode === "broker" ? Object.values(modelAuth.headers ?? {}) : [modelAuth.apiKey]),
    ...(credentials.githubToken ? [credentials.githubToken] : []),
  ];
}

/** Host of the model endpoint the sandbox talks to: the broker in broker mode, Anthropic otherwise. */
export function modelHostOf(modelAuth: SandboxModelAuth): string {
  return modelAuth.mode === "broker" ? new URL(modelAuth.baseUrl).hostname : ANTHROPIC_API_HOST;
}

/** Host a clone URL reaches: http(s) and ssh URLs, or scp-style `user@host:path`. */
export function repoHostOf(repo: string): string | null {
  try {
    const host = new URL(repo).hostname;
    if (host) return host;
  } catch {
    // Not a URL; try scp-style below.
  }
  const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):/.exec(repo);
  return scp?.[1] ?? null;
}

/** First 16 hex chars of sha256(installation key): identifies this host in E2B metadata without naming it. */
export function sandboxHostId(installationKey: string = readOrCreateInstallationKey()): string {
  return createHash("sha256").update(installationKey).digest("hex").slice(0, 16);
}

/**
 * Placeholder E2B's proxy resolves to a stored secret's value (what `Secret.fill` returns).
 * Header values set this way never appear in sandbox info, unlike literal header values.
 */
export function e2bSecretPlaceholder(name: string): string {
  return `\${e2b.secrets.${name}}`;
}

/** The slice of E2B's secret store the runner uses; tests pass a fake. */
export interface SandboxSecretStore {
  put(name: string, value: string): Promise<void>;
  destroy(name: string): Promise<void>;
}

export interface SandboxNetworkRule {
  transform: { headers: Record<string, string> };
}

export interface SandboxNetwork {
  allowOut: string[];
  denyOut: string[];
  rules: Record<string, SandboxNetworkRule[]>;
}

export interface SandboxNetworkConfig {
  repoHost: string | null;
  modelHost: string;
  /** Headers E2B adds on the model host (`x-api-key` placeholder, broker grant); none in env mode. */
  modelHeaders: Record<string, string>;
  /** `Authorization` value E2B adds on github.com while cloning; dropped afterwards. */
  githubAuthorization: string | null;
  allowHosts: string[];
  egress: SandboxEgressMode;
}

/**
 * Egress policy for one phase of a run. Everything is denied except what is listed:
 * the clone phase reaches the repo host and the model host; the run phase reaches
 * the model host, `--allow-host` entries and (unless strict) the dev registries.
 * Rules only add headers; a host still has to be in allowOut to be reachable.
 */
export function buildSandboxNetwork(phase: "clone" | "run", cfg: SandboxNetworkConfig): SandboxNetwork {
  const allowOut = new Set<string>([cfg.modelHost]);
  const rules: Record<string, SandboxNetworkRule[]> = {};
  if (Object.keys(cfg.modelHeaders).length > 0) rules[cfg.modelHost] = [{ transform: { headers: cfg.modelHeaders } }];
  if (phase === "clone") {
    if (cfg.repoHost) allowOut.add(cfg.repoHost);
    if (cfg.githubAuthorization && cfg.repoHost === "github.com") {
      rules["github.com"] = [{ transform: { headers: { Authorization: cfg.githubAuthorization } } }];
    }
  } else {
    for (const host of cfg.allowHosts) allowOut.add(host);
    if (cfg.egress === "dev-registries") for (const host of DEV_REGISTRY_HOSTS) allowOut.add(host);
  }
  return { allowOut: [...allowOut], denyOut: [ALL_TRAFFIC], rules };
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

/** The few builder calls the template uses; the real `Template()` chain or a recording fake. */
export interface TemplateBuilderLike {
  fromBaseImage(): TemplateBuilderLike;
  aptInstall(packages: string[]): TemplateBuilderLike;
  runCmd(commands: string | string[], options?: { user?: string }): TemplateBuilderLike;
  gitClone(url: string, path: string, options?: { branch?: string; depth?: number }): TemplateBuilderLike;
  setStartCmd(startCommand: string, readyCommand: unknown): TemplateBuilderLike;
  skipCache(): TemplateBuilderLike;
}

export interface TemplateBuildOptions {
  apiKey: string;
  cpuCount: number;
  memoryMB: number;
  tags: string[];
  onBuildLogs?: (entry: { message?: unknown }) => void;
}

/** The slice of the e2b Template API the builder uses; tests pass a fake. */
export interface E2bTemplateDeps {
  Template: () => TemplateBuilderLike;
  build: (
    template: TemplateBuilderLike,
    name: string,
    options: TemplateBuildOptions,
  ) => Promise<{ name?: string; templateId: string; buildId: string }>;
  waitForPort: (port: number) => unknown;
}

export interface BuildE2bTemplateOptions {
  name?: string;
  ref?: string;
  cpu?: number;
  memoryMB?: number;
  apiKey: string;
  onLog?: (line: string) => void;
  /** Turns a branch or tag into its commit SHA on the host; defaults to `git ls-remote`. */
  resolveRef?: (repo: string, ref: string) => Promise<string | null>;
  deps?: E2bTemplateDeps;
  /** Where the build record goes; defaults to ~/.ravi/sandbox-templates.json. */
  recordPath?: string;
  now?: () => number;
}

/** What `sandbox run` reads back to say which Ravi a template holds. */
export interface E2bTemplateRecord {
  name: string;
  templateId: string;
  buildId: string;
  ref: string;
  sha: string;
  bunVersion: string;
  natsVersion: string;
  builtAt: string;
}

export interface BuildE2bTemplateResult extends E2bTemplateRecord {
  durationMs: number;
}

export function sandboxTemplatesPath(): string {
  return join(getRaviStateDir(), "sandbox-templates.json");
}

/** The record of the last build of `name`, or null when none was recorded (or the file is unreadable). */
export function readE2bTemplateRecord(name: string, path: string = sandboxTemplatesPath()): E2bTemplateRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { templates?: Record<string, E2bTemplateRecord> };
    const record = parsed.templates?.[name];
    return record && GIT_SHA_RE.test(record.sha ?? "") ? record : null;
  } catch {
    return null;
  }
}

function writeE2bTemplateRecord(record: E2bTemplateRecord, path: string): void {
  let templates: Record<string, E2bTemplateRecord> = {};
  try {
    templates = (JSON.parse(readFileSync(path, "utf8")) as { templates?: typeof templates }).templates ?? {};
  } catch {
    // First build, or a corrupt file: start over.
  }
  templates[record.name] = record;
  writeUserOnlyFile(path, `${JSON.stringify({ version: 1, templates }, null, 2)}\n`);
}

/**
 * The SHA `ref` names in `git ls-remote` output: the branch first, then the peeled tag
 * (the commit, not the tag object), then the tag itself. Null when nothing matches.
 */
export function pickLsRemoteSha(output: string, ref: string): string | null {
  const lines = output
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && GIT_SHA_RE.test(parts[0]));
  for (const wanted of [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]) {
    const hit = lines.find(([, name]) => name === wanted);
    if (hit) return hit[0];
  }
  return null;
}

async function gitLsRemoteSha(repo: string, ref: string): Promise<string | null> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", "--heads", "--tags", repo, ref, `${ref}^{}`],
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
  return pickLsRemoteSha(output, ref);
}

/**
 * Build the template from one commit of the public Ravi repository. `ref` (a branch,
 * a tag or a 40-hex SHA) is resolved on the host, and the SHA is what the sandbox
 * checks out and verifies; it is also in the command string, so E2B's layer cache
 * is invalidated exactly when the commit changes and `skipCache` is not needed.
 * Bun and nats-server come from pinned release archives verified with `sha256sum -c`.
 */
export async function buildE2bTemplate(options: BuildE2bTemplateOptions): Promise<BuildE2bTemplateResult> {
  const deps = options.deps ?? (await e2bTemplateDeps());
  const now = options.now ?? Date.now;
  const name = options.name ?? DEFAULT_E2B_TEMPLATE;
  const ref = (options.ref ?? DEFAULT_E2B_TEMPLATE_REF).trim();
  if (!ref || /\s/.test(ref) || ref.startsWith("-"))
    throw new SandboxConfigError(`Invalid --ref: ${JSON.stringify(ref)}`);
  const refIsSha = GIT_SHA_RE.test(ref.toLowerCase());
  const sha = refIsSha ? ref.toLowerCase() : await (options.resolveRef ?? gitLsRemoteSha)(RAVI_REPO, ref);
  if (!sha || !GIT_SHA_RE.test(sha)) {
    throw new SandboxConfigError(
      `Cannot resolve --ref ${JSON.stringify(ref)} to a commit on ${RAVI_REPO} (git ls-remote found no branch or tag ` +
        "with that name). Pass a branch, a tag or a 40-hex commit SHA.",
    );
  }

  const natsTarball = `nats-server-v${NATS_VERSION}-linux-amd64`;
  const natsUrl = `https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/${natsTarball}.tar.gz`;
  const bunUrl = `https://github.com/oven-sh/bun/releases/download/bun-v${TEMPLATE_BUN_VERSION}/bun-linux-x64.zip`;
  // Agent Bash tools call `ravi` by name, so it has to be on the default PATH.
  const raviWrapper = `#!/usr/bin/env bash\nexport RAVI_ALLOW_STALE_BUNDLE=1\nexec ${TEMPLATE_RAVI_DIR}/bin/ravi "$@"\n`;

  const template = deps
    .Template()
    .fromBaseImage()
    .aptInstall(["git", "curl", "unzip", "ca-certificates", "jq"])
    // Downloads are saved, checked against the pinned digest and only then unpacked.
    .runCmd(
      [
        `curl -fsSL -o /tmp/${natsTarball}.tar.gz ${natsUrl}`,
        `echo "${NATS_LINUX_AMD64_SHA256}  /tmp/${natsTarball}.tar.gz" | sha256sum -c -`,
        `tar xzf /tmp/${natsTarball}.tar.gz -C /tmp`,
        `install -m 0755 /tmp/${natsTarball}/nats-server /usr/local/bin/nats-server`,
        `rm -rf /tmp/${natsTarball} /tmp/${natsTarball}.tar.gz`,
      ],
      { user: "root" },
    )
    .runCmd(
      [
        `curl -fsSL -o /tmp/bun-linux-x64.zip ${bunUrl}`,
        `echo "${TEMPLATE_BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum -c -`,
        "unzip -q /tmp/bun-linux-x64.zip -d /tmp",
        // bun must be on PATH before building: Ravi's prebuild script calls it by name.
        "install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun",
        "rm -rf /tmp/bun-linux-x64 /tmp/bun-linux-x64.zip",
        `printf '%s' ${shellQuote(raviWrapper)} > /usr/local/bin/ravi && chmod +x /usr/local/bin/ravi`,
      ],
      { user: "root" },
    )
    // The clone layer may be served from E2B's cache; the next step fetches the exact
    // commit and fails unless HEAD is that SHA, so a stale layer cannot leak through.
    // The build step re-checks HEAD for the same reason.
    .gitClone(RAVI_REPO, TEMPLATE_RAVI_DIR, { branch: refIsSha ? "dev" : ref, depth: 50 })
    .runCmd(
      `cd ${TEMPLATE_RAVI_DIR} && git fetch --depth 1 origin ${sha} && git checkout --detach ${sha} && ` +
        `test "$(git rev-parse HEAD)" = ${sha}`,
    )
    // The SHA is in this command string too, so the build layer's cache key changes with
    // the commit whatever E2B keys the previous layer on, and a cached build of another
    // checkout cannot be reused.
    .runCmd(
      `cd ${TEMPLATE_RAVI_DIR} && test "$(git rev-parse HEAD)" = ${sha} && bun install --frozen-lockfile && bun run build`,
    )
    .runCmd("mkdir -p /home/user/.ravi/jetstream /home/user/work")
    .setStartCmd("nats-server -js -sd /home/user/.ravi/jetstream -a 127.0.0.1 -p 4222", deps.waitForPort(4222));

  const startedAt = now();
  const info = await deps.build(template, name, {
    apiKey: options.apiKey,
    cpuCount: options.cpu ?? 2,
    memoryMB: options.memoryMB ?? 4096,
    tags: [sha.slice(0, 12)],
    onBuildLogs: options.onLog ? (entry) => options.onLog?.(String(entry.message ?? entry)) : undefined,
  });
  const record: E2bTemplateRecord = {
    name: info.name ?? name,
    templateId: info.templateId,
    buildId: info.buildId,
    ref,
    sha,
    bunVersion: TEMPLATE_BUN_VERSION,
    natsVersion: NATS_VERSION,
    builtAt: new Date(now()).toISOString(),
  };
  writeE2bTemplateRecord(record, options.recordPath ?? sandboxTemplatesPath());
  return { ...record, durationMs: now() - startedAt };
}

async function e2bTemplateDeps(): Promise<E2bTemplateDeps> {
  const { Template, waitForPort } = await import("e2b");
  type RealTemplate = Parameters<typeof Template.build>[0];
  return {
    Template: () => Template() as unknown as TemplateBuilderLike,
    build: (template, name, options) => Template.build(template as unknown as RealTemplate, name, options),
    waitForPort,
  };
}

// ---------------------------------------------------------------------------
// Task run

/** What `commands.run` returns: a finished result, or (background) a handle on the running command. */
export interface SandboxCommandRun {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  wait?: () => Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
  kill?: () => Promise<unknown>;
  disconnect?: () => Promise<unknown>;
}

/** The slice of the E2B Sandbox API the runner uses; tests pass a fake. */
export interface SandboxHandle {
  sandboxId: string;
  commands: {
    /**
     * With `background: true` the SDK returns a handle at once (`wait`, `kill`, `disconnect`);
     * output streams through `onStdout`/`onStderr` as it arrives, and the SDK keeps a copy of
     * all of it until the command ends.
     */
    run(
      cmd: string,
      opts?: {
        timeoutMs?: number;
        background?: boolean;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ): Promise<SandboxCommandRun>;
  };
  files: {
    write(path: string, data: string): Promise<unknown>;
  };
  /** Replaces the whole egress policy: a missing field is cleared on the server, so every field is required here. */
  updateNetwork(network: SandboxNetwork): Promise<unknown>;
  /** What E2B says about the sandbox; `templateId` is the template it actually booted from. */
  getInfo(): Promise<{ templateId: string }>;
  kill(): Promise<unknown>;
  pause(): Promise<unknown>;
}

export interface CreateSandboxInput {
  template: string;
  apiKey: string;
  timeoutMs: number;
  envs: Record<string, string>;
  metadata: Record<string, string>;
  network: SandboxNetwork & { allowPublicTraffic: false };
  lifecycle: { onTimeout: "kill"; autoResume: false };
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
  /** Extra hosts the worker may reach after the clone (`--allow-host`). */
  allowHosts?: string[];
  egress?: SandboxEgressMode;
  /** How GITHUB_TOKEN reaches the clone (`--github-auth`); defaults to `header`. */
  githubAuth?: SandboxGithubAuthMode;
  /** `ravi_host` metadata; defaults to sandboxHostId(). */
  hostId?: string;
  /** `ravi_pid` metadata, so `sandbox reap` can tell an orphan from a live run; defaults to process.pid. */
  pid?: number;
  /** The build record for the template; defaults to the one in ~/.ravi/sandbox-templates.json (null when none). */
  templateRecord?: E2bTemplateRecord | null;
  onStep?: (message: string) => void;
  pollIntervalMs?: number;
  createSandbox?: (input: CreateSandboxInput) => Promise<SandboxHandle>;
  /** Holds the per-run secrets E2B's proxy injects; defaults to E2B's secret store. */
  secretStore?: SandboxSecretStore;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after Ctrl-C/SIGTERM cleanup; defaults to process.exit. */
  exit?: (code: number) => void;
  /** Longest the Ctrl-C/SIGTERM cleanup (kill or pause, then secret removal) may take before exiting anyway; tests shorten it. */
  signalCleanupTimeoutMs?: number;
  /** What collection may receive from the sandbox before it stops reading; defaults to MAX_TOTAL, tests shorten it. */
  maxCollectedBytes?: number;
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
  /**
   * How the run ended, as the sandbox reported it: a task status (`done`, `failed`,
   * `blocked`), `invalid` when the sandbox's answer was not a task status, or the
   * runner's own `timeout`, `error` or `aborted`. Unverified: the machine that said
   * it is the one the worker controls.
   */
  reportedStatus: string;
  /** Same value as `reportedStatus`; kept for scripts that read `status`. */
  status: string;
  /** Advisory review of `changes.patch` (null when no patch was saved). Never applied. */
  review: PatchReview | null;
  kept: boolean;
  outputDir: string;
  files: string[];
  durationMs: number;
  error: string | null;
  /** What E2B recorded about the sandbox (null when it could not be fetched). */
  e2b: E2bTelemetrySummary | null;
  /** Template id the sandbox booted from, as E2B reports it (null when `getInfo` failed or the run ended before it). */
  templateId: string | null;
  /**
   * Ravi commit baked into the template, from this host's build record; null when there is
   * no record or the sandbox's template id is not the one the record names.
   */
  templateSha: string | null;
  /** The template line of run.log, after `Template <name>: `; the CLI prints the same text. */
  templateNote: string;
}

/**
 * What a run can say about its template. The record is "last built from this host", not
 * a fact about the sandbox: only when E2B's template id for the sandbox is the recorded
 * one does the record's commit describe the machine. A template rebuilt elsewhere (same
 * name, another id) is reported as such and `templateSha` stays null.
 */
export function describeTemplate(
  record: E2bTemplateRecord | null,
  templateId: string | null,
  infoError?: string,
): { templateSha: string | null; templateNote: string } {
  if (!record) {
    const seen = templateId ? `id ${templateId}, ` : "";
    return {
      templateSha: null,
      templateNote: `${seen}no build record on this host (warning: run \`ravi sandbox template build\` to pin a commit)`,
    };
  }
  if (templateId === null) {
    return {
      templateSha: null,
      templateNote:
        `id could not be read${infoError ? ` (${infoError})` : ""}; this host's record ` +
        `(${record.templateId}, ravi ${record.sha}) is unverified`,
    };
  }
  if (templateId !== record.templateId) {
    return {
      templateSha: null,
      templateNote:
        `id ${templateId} does not match this host's record (${record.templateId}, ravi ${record.sha}) ` +
        "— rebuilt elsewhere?",
    };
  }
  return { templateSha: record.sha, templateNote: `ravi ${record.sha} (built ${record.builtAt} on this host)` };
}

/** The process exit code for a run: 0 only when the sandbox reported `done`. */
export function sandboxRunExitCode(result: Pick<RunSandboxTaskResult, "reportedStatus">): 0 | 1 {
  return result.reportedStatus === "done" ? 0 : 1;
}

/** Longest file name `safeFileName` returns, in bytes (it is ASCII); suffixes like `.trace.jsonl.TOO_LARGE.txt` fit under 255. */
export const MAX_FILE_NAME_BYTES = 120;

/**
 * File name for a session or transcript path, safe on any filesystem. A plain name
 * (lower-case letters, digits, `.`, `_`, `-`; at most MAX_FILE_NAME_BYTES) is kept as it
 * is; anything else is cleaned, shortened, and given `~` and a hash of the original, so
 * names that clean to the same text (`a b`, `a:b`) or differ only in case (on a
 * case-insensitive disk) still get distinct files. `~` never survives the cleaning, so
 * a kept name cannot pose as a hashed one.
 */
export function safeFileName(value: string): string {
  if (/^[a-z0-9-][a-z0-9._-]*$/.test(value) && !value.endsWith("_") && value.length <= MAX_FILE_NAME_BYTES) {
    return value;
  }
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "");
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  const ext = /\.[A-Za-z0-9]{1,10}$/.exec(cleaned)?.[0] ?? "";
  const room = MAX_FILE_NAME_BYTES - ext.length - hash.length - 1;
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, room) || "unnamed";
  return `${stem}~${hash}${ext}`;
}

/** Thrown when a sandbox command streams back more than the host accepts; the command was killed. */
export class SandboxStreamLimitError extends Error {
  constructor(
    label: string,
    readonly received: number,
    readonly limit: number,
  ) {
    super(
      `\`${label.length > 120 ? `${label.slice(0, 117)}...` : label}\` sent more than ${formatBytes(limit)} ` +
        `(${received} bytes received); the command was killed`,
    );
    this.name = "SandboxStreamLimitError";
  }
}

/**
 * The task status in a `ravi tasks show --json` answer from the sandbox. The text is
 * untrusted: it is parsed only when it is within `MAX_JSON`, only through the schema,
 * and only one of the six task statuses comes out; anything else is `invalid`.
 */
export function parseReportedTask(json: string, overflow = false): { status: string; progress: number } {
  if (overflow) return { status: "invalid", progress: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { status: "invalid", progress: 0 };
  }
  const shown = taskShowSchema.safeParse(parsed);
  if (!shown.success) return { status: "invalid", progress: 0 };
  const task = shown.data.task ?? shown.data;
  return { status: task.status ?? "invalid", progress: task.progress ?? 0 };
}

async function createE2bSandbox(input: CreateSandboxInput): Promise<SandboxHandle> {
  const { Sandbox } = await import("e2b");
  return (await Sandbox.create(input.template, {
    apiKey: input.apiKey,
    timeoutMs: input.timeoutMs,
    envs: input.envs,
    metadata: input.metadata,
    network: input.network,
    lifecycle: input.lifecycle,
  })) as unknown as SandboxHandle;
}

function e2bSecretStore(apiKey: string): SandboxSecretStore {
  return {
    async put(name, value) {
      const { Secret } = await import("e2b");
      if (await Secret.exists(name, { apiKey })) await Secret.update(name, value, { apiKey });
      else await Secret.create(name, value, { apiKey });
    },
    async destroy(name) {
      const { Secret } = await import("e2b");
      await Secret.destroy(name, { apiKey });
    },
  };
}

export async function runE2bSandboxTask(options: RunSandboxTaskOptions): Promise<RunSandboxTaskResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const { credentials } = options;
  const { modelAuth } = credentials;
  const timeoutMin = options.timeoutMin ?? DEFAULT_SANDBOX_TIMEOUT_MIN;
  if (!Number.isInteger(timeoutMin) || timeoutMin < 1 || timeoutMin > MAX_SANDBOX_TIMEOUT_MIN) {
    throw new SandboxConfigError(`timeoutMin must be an integer from 1 to ${MAX_SANDBOX_TIMEOUT_MIN}.`);
  }
  if (options.keep && modelAuth.mode === "env") {
    throw new SandboxConfigError(
      "--keep is refused with `env` model auth: a paused sandbox would keep the real API key in its snapshot. " +
        "Use header or broker mode.",
    );
  }
  const title = options.title ?? "Sandbox task";
  const taskTextBytes = Buffer.byteLength(title) + Buffer.byteLength(options.instructions);
  if (taskTextBytes > MAX_TASK_TEXT_BYTES) {
    throw new SandboxConfigError(
      `Title and instructions are ${taskTextBytes} bytes; the limit is ${MAX_TASK_TEXT_BYTES} (100 KiB). ` +
        "Put the long material in the repository and refer to it.",
    );
  }
  const secrets = sandboxSecretValues(credentials);
  // Every step also goes to run.log; lines before the output dir exists are buffered.
  let runLog: string | null = null;
  let outputDirRef: string | null = null;
  const pendingRunLog: string[] = [];
  const step = (message: string) => {
    const line = `[${((now() - startedAt) / 1000).toFixed(1)}s] ${message}`;
    // Steps quote the sandbox's stderr and names: printed without terminal controls,
    // saved (redacted) as they came.
    options.onStep?.(stripTerminalControls(line));
    if (!runLog) {
      pendingRunLog.push(line);
      return;
    }
    try {
      appendPrivate(runLog, `${redactSecrets(line, secrets)}\n`, outputDirRef ?? undefined);
    } catch {
      // A failed diagnostic write must never stand between the run and the sandbox's cleanup.
    }
  };
  const template = options.template ?? DEFAULT_E2B_TEMPLATE;
  const templateRecord =
    options.templateRecord === undefined ? readE2bTemplateRecord(template) : options.templateRecord;
  const timeoutMs = timeoutMin * 60_000;
  const runId = randomBytes(12).toString("hex");

  // Per-run secrets E2B's proxy injects as headers. Only placeholders reach the sandbox
  // config, so `getInfo` (anyone with the E2B key) never shows the values.
  const secretStore = options.secretStore ?? e2bSecretStore(credentials.e2bApiKey);
  const storedSecrets: string[] = [];
  const storeSecret = async (suffix: string, value: string): Promise<string> => {
    const name = `ravi-sbx-${runId}-${suffix}`;
    await secretStore.put(name, value);
    storedSecrets.push(name);
    return e2bSecretPlaceholder(name);
  };
  // Each name is taken off the list before its destroy call, so a destroy that hangs or
  // a second cleanup pass (signal handler, then the normal path) never repeats it.
  const destroySecret = async (name: string) => {
    const at = storedSecrets.indexOf(name);
    if (at < 0) return;
    storedSecrets.splice(at, 1);
    await secretStore.destroy(name).catch((err) => {
      step(`Could not remove E2B secret ${name}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const destroySecrets = async () => {
    for (const name of [...storedSecrets]) await destroySecret(name);
  };

  const envs: Record<string, string> = {
    RAVI_ALLOW_STALE_BUNDLE: "1",
    // Denied hosts would otherwise be hammered by telemetry and update checks.
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_API_KEY: modelAuth.mode === "env" ? modelAuth.apiKey : SANDBOX_PLACEHOLDER_API_KEY,
  };
  if (modelAuth.mode === "broker") envs.ANTHROPIC_BASE_URL = modelAuth.baseUrl;
  const source = resolveCloneSource(options.repo, credentials.githubToken);
  if (source.urlPassword) secrets.push(source.urlPassword);
  const networkConfig: SandboxNetworkConfig = {
    repoHost: repoHostOf(source.url),
    modelHost: modelHostOf(modelAuth),
    // Broker mode: `headers` is the grant slice 06b fills. Every value in `rules` is
    // visible to anyone holding the E2B key (SandboxInfo), so 06b must store the grant
    // in the secret store and pass `${e2b.secrets.<name>}` placeholders here, never the
    // literal value. The test "puts only secret-store placeholders in rules" guards it.
    modelHeaders: modelAuth.mode === "broker" ? { ...modelAuth.headers } : {},
    githubAuthorization: null,
    allowHosts: options.allowHosts ?? [],
    egress: options.egress ?? "dev-registries",
  };
  // Whether the clone's credential goes through git's credential file (#623) instead of a header.
  let cloneCredentialLine = source.credentialLine;
  const githubAuth = source.urlPassword ? null : githubCloneAuth(options.repo, credentials.githubToken);
  // The GitHub secret is destroyed right after the clone, not at run end; its name is kept for that.
  let githubSecretName: string | null = null;
  try {
    if (modelAuth.mode === "header") {
      networkConfig.modelHeaders["x-api-key"] = await storeSecret("anthropic", modelAuth.apiKey);
    }
    if (githubAuth && (options.githubAuth ?? "header") === "header") {
      const basic = Buffer.from(`${githubAuth.username}:${githubAuth.password}`).toString("base64");
      try {
        networkConfig.githubAuthorization = await storeSecret("github", `Basic ${basic}`);
        githubSecretName = storedSecrets[storedSecrets.length - 1] ?? null;
        cloneCredentialLine = null;
      } catch (err) {
        step(
          `E2B secret store unavailable (${err instanceof Error ? err.message : String(err)}); the clone uses a credential file`,
        );
      }
    }
  } catch (err) {
    await destroySecrets();
    throw err;
  }

  // Ctrl-C or SIGTERM must not leave a billable, credential-holding sandbox running,
  // not even one whose create call has not returned yet.
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const exitCodeFor = (signal: NodeJS.Signals) => (signal === "SIGINT" ? 130 : 143);
  const cleanupTimeoutMs = options.signalCleanupTimeoutMs ?? SIGNAL_CLEANUP_TIMEOUT_MS;
  // One limit over the whole cleanup (kill or pause, then the secrets): a hanging E2B
  // call, in either step, must not keep the process alive longer than this.
  const withCleanupLimit = (cleanup: () => Promise<unknown>) => {
    const limit = new Promise((resolve) => setTimeout(resolve, cleanupTimeoutMs).unref?.());
    return Promise.race([
      cleanup()
        .catch(() => {})
        .then(destroySecrets),
      limit,
    ]).catch(() => {});
  };
  // A kept sandbox is paused with no egress, no injected credentials and no daemon
  // waiting for work, so resuming it later cannot reach out with anything.
  const pauseLocked = async (handle: SandboxHandle) => {
    await handle.updateNetwork({ allowOut: [], denyOut: [ALL_TRAFFIC], rules: {} });
    if (daemonStarted) {
      // `[r]avi` keeps the pattern from matching the shell that runs this very pkill.
      await handle.commands.run("pkill -f '[r]avi daemon run' || true", { timeoutMs: 10_000 }).catch(() => {});
    }
    await handle.pause();
  };
  let sandboxRef: SandboxHandle | null = null;
  let pendingSignal: NodeJS.Signals | null = null;
  // Set by the first signal; later ones are ignored (noted once) so that a second Ctrl-C
  // during a slow kill neither removes the handler nor exits with the sandbox still up.
  let signalCleanup: Promise<unknown> | null = null;
  let repeatNoted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalCleanup || pendingSignal) {
      if (!repeatNoted) {
        repeatNoted = true;
        step(`${signal} received again; cleanup in progress, the sandbox is removed before this exits`);
      }
      return;
    }
    const live = sandboxRef;
    if (!live) {
      pendingSignal = signal;
      step(`${signal} received while the sandbox is being created; it is killed as soon as E2B returns it`);
      return;
    }
    step(
      `${signal} received, ${options.keep ? "pausing" : "killing"} sandbox ${live.sandboxId}; ` +
        `\`ravi sandbox logs ${live.sandboxId}\` fetches what E2B recorded`,
    );
    // Handlers stay installed until the cleanup has settled (or hit its limit).
    signalCleanup = withCleanupLimit(() => (options.keep ? pauseLocked(live) : live.kill())).finally(() => {
      offSignals();
      exit(exitCodeFor(signal));
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const offSignals = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };

  if (!templateRecord) {
    step(
      `Warning: no build record for template ${template} in ${sandboxTemplatesPath()}; ` +
        "which Ravi commit it holds is unknown. `ravi sandbox template build` records one.",
    );
  }
  step(`Creating sandbox from ${template}`);
  let created: SandboxHandle;
  try {
    created = await (options.createSandbox ?? createE2bSandbox)({
      template,
      apiKey: credentials.e2bApiKey,
      // Sandbox lifetime; the task poll below stops a little earlier.
      timeoutMs: timeoutMs + 5 * 60_000,
      envs,
      metadata: {
        purpose: "ravi-task",
        ravi_run: runId,
        ravi_host: options.hostId ?? sandboxHostId(),
        ravi_pid: String(options.pid ?? process.pid),
      },
      network: { ...buildSandboxNetwork("clone", networkConfig), allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
  } catch (err) {
    offSignals();
    await destroySecrets();
    throw err;
  }
  const sandbox = created;
  sandboxRef = sandbox;
  if (pendingSignal) {
    step(`Killing sandbox ${sandbox.sandboxId} (${pendingSignal} arrived during create)`);
    await withCleanupLimit(() => sandbox.kill());
    offSignals();
    exit(exitCodeFor(pendingSignal));
    return {
      sandboxId: sandbox.sandboxId,
      taskId: null,
      reportedStatus: "aborted",
      status: "aborted",
      review: null,
      kept: false,
      outputDir: options.outputDir ?? join(getRaviStateDir(), "sandbox-runs", sandbox.sandboxId),
      files: [],
      durationMs: now() - startedAt,
      error: `${pendingSignal} received during sandbox creation`,
      e2b: null,
      templateId: null,
      ...describeTemplate(templateRecord, null, "aborted before the sandbox was inspected"),
    };
  }
  step(`Sandbox ${sandbox.sandboxId} is up`);
  // The record says what this host built last; E2B says what the sandbox booted from.
  let templateId: string | null = null;
  let infoError: string | undefined;
  try {
    templateId = (await sandbox.getInfo()).templateId ?? null;
  } catch (err) {
    infoError = err instanceof Error ? err.message : String(err);
  }
  const { templateSha, templateNote } = describeTemplate(templateRecord, templateId, infoError);
  step(`Template ${template}: ${templateNote}`);

  const outputDir = options.outputDir ?? join(getRaviStateDir(), "sandbox-runs", sandbox.sandboxId);
  const files: string[] = [];
  try {
    // Owner-only: the files below hold the repository's changes and the worker's transcripts.
    mkdirPrivate(outputDir);
    writePrivate(
      join(outputDir, "run.log"),
      pendingRunLog.map((line) => `${redactSecrets(line, secrets)}\n`).join(""),
      outputDir,
    );
  } catch (err) {
    // Don't leave a billable, credential-holding sandbox running until its timeout.
    offSignals();
    await sandbox.kill().catch(() => {});
    await destroySecrets();
    throw err;
  }
  runLog = join(outputDir, "run.log");
  outputDirRef = outputDir;
  files.push("run.log");

  // Bytes every command streamed back to the host, counted as they arrive.
  let receivedBytes = 0;
  /**
   * Run `cmd`, counting what it streams back on stdout and stderr. Past `limit` it is
   * killed and the call fails: the sandbox decides how much it sends, whatever the
   * wrapper around the command says, and the SDK holds all of it until the command ends.
   */
  const exec = async (cmd: string, cmdTimeoutMs: number, limit: number, label = cmd) => {
    let received = 0;
    let tripped = false;
    let handle: SandboxCommandRun | null = null;
    let trip: () => void = () => {};
    const overLimit = new Promise<null>((resolve) => {
      trip = () => resolve(null);
    });
    const stop = () => {
      handle?.disconnect?.().catch(() => {});
      handle?.kill?.().catch(() => {});
    };
    const count = (chunk: string) => {
      const bytes = Buffer.byteLength(chunk);
      received += bytes;
      receivedBytes += bytes;
      if (!tripped && received > limit) {
        tripped = true;
        stop();
        trip();
      }
    };
    handle = await sandbox.commands.run(cmd, {
      background: true,
      timeoutMs: cmdTimeoutMs,
      onStdout: count,
      onStderr: count,
    });
    if (tripped) stop();
    const started: SandboxCommandRun = handle;
    const result = await Promise.race([started.wait ? started.wait() : Promise.resolve(started), overLimit]);
    if (result === null || received > limit) throw new SandboxStreamLimitError(label, received, limit);
    return result;
  };
  const run = async (cmd: string, cmdTimeoutMs = 120_000) => {
    try {
      return (await exec(cmd, cmdTimeoutMs, MAX_COMMAND_OUTPUT)).stdout ?? "";
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
  // still leaves its log behind; the full file replaces the copy at the end. Host
  // memory and disk stay bounded whatever the sandbox streams: a line without its
  // newline is held up to MAX_DAEMON_LINE characters (the rest of it is dropped), and
  // once MAX_DAEMON_LOG bytes have arrived the tail is disconnected.
  const daemonLogPath = join(outputDir, "daemon.log");
  let daemonTail: SandboxCommandRun | null = null;
  let partialLine = "";
  let cuttingLine = false;
  let liveReceived = 0;
  let liveWritten = 0;
  let tailStopped = false;
  const stopTail = () => {
    tailStopped = true;
    daemonTail?.disconnect?.().catch(() => {});
  };
  const onDaemonChunk = (chunk: string) => {
    if (tailStopped) return;
    liveReceived += Buffer.byteLength(chunk);
    const lines: string[] = [];
    const parts = chunk.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (!cuttingLine) {
        const room = MAX_DAEMON_LINE - partialLine.length;
        if (parts[i].length > room) {
          lines.push(`${partialLine}${parts[i].slice(0, room)} [ravi: line cut at ${MAX_DAEMON_LINE} characters]`);
          partialLine = "";
          cuttingLine = true;
        } else {
          partialLine += parts[i];
        }
      }
      if (i < parts.length - 1) {
        if (!cuttingLine) lines.push(partialLine);
        partialLine = "";
        cuttingLine = false;
      }
    }
    const redacted = lines.map((line) => redactSecrets(line, secrets));
    const text = redacted.map((line) => `${line}\n`).join("");
    const bytes = Buffer.byteLength(text);
    const atCap = liveReceived > MAX_DAEMON_LOG || liveWritten + bytes > MAX_DAEMON_LOG;
    try {
      if (!atCap && bytes > 0) appendPrivate(daemonLogPath, text, outputDir);
      else if (atCap) appendPrivate(daemonLogPath, truncationMarker(MAX_DAEMON_LOG, liveReceived), outputDir);
    } catch {
      // The full log is read again at the end; losing the live copy is not fatal.
    }
    liveWritten += bytes;
    if (atCap) {
      stopTail();
      return;
    }
    for (const line of redacted) options.onDaemonLog?.(stripTerminalControls(line));
  };

  // Every read from the sandbox goes through `head -c cap + 1` in there, and the host
  // kills the command once more than cap + STREAM_MARGIN has arrived, so a sandbox that
  // ignores the wrapper still cannot send more than that.
  const runCapped = async (cmd: string, cap: number, cmdTimeoutMs = 300_000) => {
    try {
      const result = await exec(cappedCommand(cmd, cap), cmdTimeoutMs, cap + STREAM_MARGIN, cmd);
      return readCapped(result.stdout ?? "", result.stderr, cap);
    } catch (err) {
      throw describeCommandError(cmd, err);
    }
  };
  /** JSON the run parses: over MAX_JSON it is rejected, never parsed in part. */
  const readJson = async (cmd: string) => {
    const read = await runCapped(cmd, MAX_JSON, 120_000);
    if (read.overflow) throw new Error(`\`${cmd}\` returned ${formatBytes(read.bytes)} of JSON; the limit is 1 MiB`);
    return read.content.trim();
  };

  interface GrabOptions {
    cap: number;
    /** Written byte for byte (the patch, JSONL); otherwise trimmed with one final newline. */
    raw?: boolean;
    /** Over the cap: write `<name>.TOO_LARGE.txt` and nothing else (a partial patch would apply partially). */
    allOrNothing?: boolean;
    /** On failure, keep the live copy already on disk and note the failure in it. */
    keepOnFailure?: boolean;
  }
  const collectOutputs = async (taskId: string | null) => {
    // MAX_TOTAL counts what collection receives (not what it saves): once it is reached,
    // nothing more is read from the sandbox.
    const maxTotal = options.maxCollectedBytes ?? MAX_TOTAL;
    const collectionStart = receivedBytes;
    const collected = () => receivedBytes - collectionStart;
    let totalNoted = false;
    const overTotal = (name: string) => {
      if (collected() < maxTotal) return false;
      if (!totalNoted) {
        totalNoted = true;
        step(`Stopped collecting at ${name}: the run's reads reached the ${formatBytes(maxTotal)} total`);
      }
      return true;
    };
    /** Write one output file; a failure (a name clash, a full disk) is a step line, not the end of collection. */
    const save = (name: string, data: string): boolean => {
      try {
        writePrivate(join(outputDir, name), data, outputDir);
        files.push(name);
        return true;
      } catch (error) {
        step(`Could not save ${name}: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    };
    /** Save one output; returns what was written, or null when nothing was. */
    const grab = async (name: string, cmd: string, opts: GrabOptions): Promise<string | null> => {
      if (overTotal(name)) return null;
      const target = join(outputDir, name);
      let content: string;
      try {
        const read = await runCapped(cmd, opts.cap);
        if (read.overflow && opts.allOrNothing) {
          const note =
            `${name} was not saved: the sandbox produced ${formatBytes(read.bytes)} (${read.bytes} bytes), ` +
            `over the ${formatBytes(opts.cap)} limit. Nothing partial is written for this file.\n`;
          save(`${name}.TOO_LARGE.txt`, note);
          step(`${name} is over ${formatBytes(opts.cap)} (${read.bytes} bytes); not saved`);
          return null;
        }
        content = opts.raw ? read.content : `${read.content.trim()}\n`;
        if (read.overflow) content += truncationMarker(opts.cap, read.bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (opts.keepOnFailure && existsSync(target)) {
          // Keep the last line the daemon wrote even if it never got its newline.
          const unfinished = partialLine ? `${redactSecrets(partialLine, secrets)}\n` : "";
          try {
            appendPrivate(
              target,
              `${unfinished}(log copied live; full read failed: ${redactSecrets(message, secrets)})\n`,
              outputDir,
            );
            files.push(name);
          } catch (appendError) {
            step(`Could not save ${name}: ${appendError instanceof Error ? appendError.message : appendError}`);
          }
          return null;
        }
        content = `(failed: ${message})\n`;
      }
      if (collected() > maxTotal) {
        step(`Skipped ${name}: the run's reads are past the ${formatBytes(maxTotal)} total`);
        totalNoted = true;
        return null;
      }
      const redacted = redactSecrets(content, secrets);
      return save(name, redacted) ? redacted : null;
    };
    // Stop streaming but leave `tail` running: killing it would show up as a failed process in E2B's log.
    await daemonTail?.disconnect?.().catch(() => {});
    daemonTail = null;
    await grab("daemon.log", `cat ${DAEMON_LOG}`, { cap: MAX_DAEMON_LOG, raw: true, keepOnFailure: true });
    // The patch is written byte for byte; trimming would corrupt it.
    const patch = await grab(
      "changes.patch",
      `cur=$( ${worktreeTreeCmd} ) && cd ${REPO_DIR} && git diff --binary ${baselineTree ?? "HEAD"} "$cur"`,
      { cap: MAX_PATCH, raw: true, allOrNothing: true },
    );
    if (patch !== null) {
      // Advisory: which files to read before `git apply`. Nothing is applied here.
      review = reviewPatch(patch);
      save("review.json", `${JSON.stringify(review, null, 2)}\n`);
      if (review.flags.length > 0) {
        step(
          `Patch review: ${review.flags.length} flag(s) in ${review.files} file(s); see review.json before applying`,
        );
      }
    }
    if (taskId) {
      await grab("task.json", `ravi tasks show ${taskId} --json`, { cap: MAX_JSON, allOrNothing: true });
      await grab("TASK.md", `cat /home/user/.ravi/tasks/${taskId}/TASK.md`, { cap: MAX_TRANSCRIPT });
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
      if (overTotal("the session list")) return;
      const listed = JSON.parse(await readJson("ravi sessions list --json --limit 500")) as {
        items?: Array<{ name?: string; sessionKey?: string }>;
        sessions?: Array<{ name?: string; sessionKey?: string }>;
      };
      for (const session of listed.items ?? listed.sessions ?? []) {
        const name = session.name ?? session.sessionKey;
        if (typeof name === "string" && name) sessionNames.push(name);
      }
    } catch (error) {
      step(`Could not list sessions: ${error instanceof Error ? error.message : error}`);
    }
    // Session names are the sandbox's: `safeFileName` keeps every one of them under sessions/.
    for (const name of new Set(sessionNames)) {
      const base = `sessions/${safeFileName(name)}`;
      await grab(`${base}.trace.txt`, `ravi sessions trace ${shellQuote(name)} --explain`, { cap: MAX_TRANSCRIPT });
      await grab(`${base}.trace.jsonl`, `ravi sessions trace ${shellQuote(name)} --json`, {
        cap: MAX_TRANSCRIPT,
        raw: true,
      });
    }

    // Claude Code's own transcripts: every message, tool call and tool result.
    let transcripts: string[] = [];
    if (overTotal("the transcript list")) return;
    try {
      transcripts = (
        await runCapped(`find ${CLAUDE_PROJECTS_DIR} -name '*.jsonl' -type f 2>/dev/null | sort`, MAX_JSON)
      ).content
        .split("\n")
        .filter((path) => path.startsWith(`${CLAUDE_PROJECTS_DIR}/`));
    } catch {
      transcripts = [];
    }
    for (const path of transcripts.slice(0, MAX_TRANSCRIPTS)) {
      const relative = path.slice(CLAUDE_PROJECTS_DIR.length + 1);
      const name = relative.split("/").map(safeFileName).join("/");
      await grab(`transcripts/${name}`, `cat ${shellQuote(path)}`, { cap: MAX_TRANSCRIPT, raw: true });
    }
    if (transcripts.length > MAX_TRANSCRIPTS) {
      step(`Saved ${MAX_TRANSCRIPTS} of ${transcripts.length} transcripts`);
    }
  };

  let taskId: string | null = null;
  let daemonStarted = false;
  let status = "unknown";
  let review: PatchReview | null = null;
  let error: string | null = null;
  try {
    await sh(
      "timeout 5 bash -c '</dev/tcp/127.0.0.1/4222' || (echo 'nats-server is not listening' >&2; exit 1)",
      10_000,
    );
    step("NATS already listening (restored from snapshot)");

    step(`Cloning ${source.url}`);
    const branchArgs = options.branch ? `--branch ${shellQuote(options.branch)} --single-branch ` : "";
    const cloneArgs = `clone --depth 50 ${branchArgs}${shellQuote(source.url)} ${REPO_DIR}`;
    let cloneCmd = `git ${cloneArgs}`;
    if (cloneCredentialLine) {
      await sandbox.files.write(GIT_CREDENTIALS_FILE, cloneCredentialLine);
      // `git -c` applies to this clone only; the file is removed whatever the outcome.
      cloneCmd =
        `git -c credential.helper=${shellQuote(`store --file=${GIT_CREDENTIALS_FILE}`)} ${cloneArgs}; ` +
        `rc=$?; rm -f ${GIT_CREDENTIALS_FILE}; exit $rc`;
    }
    try {
      await run(`GIT_TERMINAL_PROMPT=0 ${cloneCmd}`, CLONE_TIMEOUT_MS);
    } catch (err) {
      if (cloneCredentialLine) await run(`rm -f ${GIT_CREDENTIALS_FILE}`).catch(() => {});
      throw new Error(redactSecrets(err instanceof Error ? err.message : String(err), secrets));
    }
    // The update replaces the whole policy, so the model rule is sent again and the
    // repo host and the GitHub credential rule are gone from here on.
    const runNetwork = buildSandboxNetwork("run", networkConfig);
    await sandbox.updateNetwork(runNetwork);
    // Nothing references the GitHub secret any more; it does not wait for the run to end.
    if (githubSecretName) await destroySecret(githubSecretName);
    step(`Egress: deny-all except ${runNetwork.allowOut.join(", ")}`);
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
      // The cap can be reached while the call above was still returning the handle.
      if (tailStopped) stopTail();
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
    // The bootstrap floor already covers tools and the tasks group; the worker only adds
    // arbitrary executables (build, test). `full-access` would also grant admin:system:*.
    await sh("ravi agents permissions worker bootstrap --capabilities 'execute:executable:*' --execute");
    baselineTree = await sh(worktreeTreeCmd);
    // `tasks create` outside a Ravi session needs an existing session to report to.
    await sh("ravi agents create operator /home/user/work --provider claude --model haiku");
    await sh("ravi agents permissions operator chat-only");
    await sh('ravi sessions send -a operator operator "Operator inbox for sandbox task reports. Reply OK."');

    step("Creating and dispatching the task");
    // Title and instructions never appear in a command string: E2B logs the unexpanded
    // command, and `$(cat …)` output is data, not shell syntax. The title comes after
    // `--`, so one starting with `-` is a title and not an option.
    await sandbox.files.write(`${TASK_TEXT_DIR}/title`, title);
    await sandbox.files.write(`${TASK_TEXT_DIR}/instructions.md`, options.instructions);
    const created = JSON.parse(
      await sh(
        `ravi tasks create --instructions "$(cat ${TASK_TEXT_DIR}/instructions.md)" ` +
          `--agent worker --report-to operator --json -- "$(cat ${TASK_TEXT_DIR}/title)"`,
      ),
    ) as { task?: { id?: string } };
    // The id is the sandbox's answer: it goes into commands, paths and printed lines only
    // if it is a task id as Ravi makes them.
    const createdId = created.task?.id;
    if (typeof createdId !== "string" || !TASK_ID_RE.test(createdId)) {
      throw new Error("ravi tasks create did not return a valid task id (task- and 8 hex digits)");
    }
    taskId = createdId;
    step(`Task ${taskId} dispatched`);

    const deadline = startedAt + timeoutMs;
    let lastLine = "";
    while (now() < deadline) {
      // The answer is the sandbox's: parsed through the schema, and only a task status counts.
      const shown = await runCapped(`ravi tasks show ${taskId} --json`, MAX_JSON, 120_000);
      const task = parseReportedTask(shown.content, shown.overflow);
      const line = `status=${task.status} progress=${task.progress}`;
      if (line !== lastLine) {
        step(line);
        lastLine = line;
      }
      if (task.status === "invalid") {
        status = "invalid";
        step("The sandbox reported something that is not a task status; the run is treated as failed");
        break;
      }
      if (TERMINAL_STATUSES.has(task.status)) {
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
    // Whatever goes wrong while collecting, the run still kills the sandbox and returns
    // its result, so the status line and the patch review are printed.
    await collectOutputs(taskId).catch((err) => {
      const message = `Collecting outputs failed: ${err instanceof Error ? err.message : String(err)}`;
      error = error ? `${error}; ${message}` : message;
      step(message);
    });
  } finally {
    offSignals();
    try {
      if (options.keep) {
        await pauseLocked(sandbox);
        step(`Sandbox ${sandbox.sandboxId} paused with egress denied`);
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
    await destroySecrets();
  }

  // E2B keeps these after the sandbox is gone, including why it ended.
  let e2b: E2bTelemetrySummary | null = null;
  try {
    const collected = await (options.collectTelemetry ?? collectE2bTelemetry)({
      sandboxId: sandbox.sandboxId,
      apiKey: credentials.e2bApiKey,
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
    reportedStatus: status,
    status,
    review,
    kept: Boolean(options.keep),
    outputDir,
    files,
    durationMs: now() - startedAt,
    error,
    e2b,
    templateId,
    templateSha,
    templateNote,
  };
}

import { spawnSync } from "node:child_process";
import { RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";

export interface ReferenceCliRunResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export type ReferenceCliRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; encoding: "utf8" },
) => ReferenceCliRunResult;

export interface ReferenceCliDeps {
  raviBin?: string;
  raviArgs?: string[];
  env?: NodeJS.ProcessEnv;
  run?: ReferenceCliRunner;
}

export interface ContextWhoamiResult {
  contextId: string;
  kind: string;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionName?: string | null;
  source?: Record<string, unknown> | null;
  createdAt: number;
  expiresAt?: number | null;
  lastUsedAt?: number | null;
  revokedAt?: number | null;
  metadata?: Record<string, unknown> | null;
  capabilitiesCount: number;
}

export interface ContextAuthorizeResult {
  contextId: string;
  agentId?: string | null;
  permission: string;
  objectType: string;
  objectId: string;
  allowed: boolean;
  approved: boolean;
  inherited: boolean;
  reason?: string | null;
  capabilitiesCount: number;
}

export interface ProbeDaemonResult {
  context: ContextWhoamiResult;
  authorization: ContextAuthorizeResult;
  daemonStatus: string;
}

export function createReferenceContextCli(deps: ReferenceCliDeps = {}) {
  const raviBin = deps.raviBin ?? process.env.RAVI_BIN ?? "ravi";
  const raviArgs = deps.raviArgs ?? [];
  const env = deps.env ?? process.env;
  const run: ReferenceCliRunner =
    deps.run ??
    ((command, args, options) => {
      const result = spawnSync(command, args, options);
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
      };
    });

  function requireContextKey(): string {
    const contextKey = env[RAVI_CONTEXT_KEY_ENV];
    if (!contextKey) {
      throw new Error(`Missing ${RAVI_CONTEXT_KEY_ENV}`);
    }
    return contextKey;
  }

  function execRavi(args: string[]): string {
    requireContextKey();

    const result = run(raviBin, [...raviArgs, ...args], {
      env,
      encoding: "utf8",
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      throw new Error(details || `Failed to run: ${[raviBin, ...raviArgs, ...args].join(" ")}`);
    }

    return stdout;
  }

  function execRaviJson<T>(args: string[]): T {
    const stdout = execRavi(args);
    return extractJsonObject(stdout) as T;
  }

  return {
    whoami(): ContextWhoamiResult {
      return execRaviJson<ContextWhoamiResult>(["context", "whoami"]);
    },

    authorize(permission: string, objectType: string, objectId: string): ContextAuthorizeResult {
      return execRaviJson<ContextAuthorizeResult>(["context", "authorize", permission, objectType, objectId]);
    },

    daemonStatus(): string {
      return execRavi(["daemon", "status"]).trim();
    },

    probeDaemon(): ProbeDaemonResult {
      const context = this.whoami();
      const authorization = this.authorize("execute", "group", "daemon");
      if (!authorization.allowed) {
        throw new Error(authorization.reason || "Permission denied for daemon status");
      }

      return {
        context,
        authorization,
        daemonStatus: this.daemonStatus(),
      };
    },
  };
}

export function runReferenceContextCli(argv = process.argv.slice(2), deps: ReferenceCliDeps = {}): void {
  const cli = createReferenceContextCli(deps);
  const [command] = argv;

  switch (command) {
    case "whoami":
      printJson(cli.whoami());
      return;
    case "probe-daemon":
      printJson(cli.probeDaemon());
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function extractJsonObject(output: string): unknown {
  const trimmed = output.trim();
  for (let start = 0; start < trimmed.length; start++) {
    if (trimmed[start] !== "{") continue;
    const end = findBalancedJsonObjectEnd(trimmed, start);
    if (end === -1) continue;

    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep scanning for the next balanced object
    }
  }

  throw new Error(`Expected JSON object in ravi output, got:\n${trimmed || "(empty output)"}`);
}

function findBalancedJsonObjectEnd(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < input.length; index++) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printUsage(): void {
  console.log(
    [
      "Reference Context CLI",
      "",
      "Usage:",
      "  bun src/reference/context-cli.ts whoami",
      "  bun src/reference/context-cli.ts probe-daemon",
      "",
      `Environment: ${RAVI_CONTEXT_KEY_ENV} must be set`,
    ].join("\n"),
  );
}

if (import.meta.main) {
  runReferenceContextCli(process.argv.slice(2));
}

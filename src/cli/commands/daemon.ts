/**
 * Daemon Commands - Manage ravi via PM2
 */

import "reflect-metadata";
import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Group, Command, Option } from "../decorators.js";
import { hasContext, fail } from "../context.js";
import { isPm2Available, runPm2, isRaviRunning, getRaviPid, getPm2Processes, PM2_PROCESS_NAME } from "../../pm2.js";

const RAVI_DIR = join(homedir(), ".ravi");
const ENV_FILE = join(RAVI_DIR, ".env");
const RESTART_REASON_FILE = join(RAVI_DIR, "restart-reason.txt");

type SourceProjectRootLookupOptions = {
  configuredPath?: string | null;
  cwd?: string;
};

type DaemonRuntimeTargetOptions = SourceProjectRootLookupOptions & {
  build?: boolean;
  configuredBundle?: string | null;
  argvEntry?: string | null;
  daemonCwd?: string | null;
};

export type DaemonRuntimeTarget = {
  bundlePath: string;
  cwd: string;
  sourceProjectRoot?: string;
};

type Pm2ProcessSnapshot = ReturnType<typeof getPm2Processes>[number];

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printJsonl(payload: unknown): void {
  console.log(JSON.stringify(payload));
}

function runPm2Quiet(args: string[], options: { cwd?: string } = {}): { status: number } {
  const result = spawnSync("pm2", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    cwd: options.cwd,
    env: process.env as Record<string, string>,
  });
  return { status: result.status ?? 1 };
}

function capturePm2(
  args: string[],
  options: { cwd?: string } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("pm2", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    cwd: options.cwd,
    env: process.env as Record<string, string>,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function serializePm2Process(process: Pm2ProcessSnapshot | undefined, fallbackName: string): Record<string, unknown> {
  if (!process) {
    return {
      name: fallbackName,
      managed: false,
      running: false,
      status: fallbackName === PM2_PROCESS_NAME ? "stopped" : "not_managed_by_pm2",
      pid: null,
      pmId: null,
      cpu: null,
      memoryBytes: null,
      memoryMb: null,
    };
  }

  return {
    name: process.name,
    managed: true,
    running: process.status === "online",
    status: process.status,
    pid: process.pid,
    pmId: process.pm_id,
    cpu: process.cpu,
    memoryBytes: process.memory,
    memoryMb: Number((process.memory / 1024 / 1024).toFixed(1)),
  };
}

function buildDaemonStatusJson(): Record<string, unknown> {
  const pm2Available = isPm2Available();
  const processes = pm2Available ? getPm2Processes() : [];
  const findProcess = (name: string) => processes.find((process) => process.name === name);

  return {
    pm2Available,
    processName: PM2_PROCESS_NAME,
    ravi: serializePm2Process(findProcess(PM2_PROCESS_NAME), PM2_PROCESS_NAME),
    infrastructure: {
      omniNats: serializePm2Process(findProcess("omni-nats"), "omni-nats"),
      omniApi: serializePm2Process(findProcess("omni-api"), "omni-api"),
    },
    processes: processes.map((process) => serializePm2Process(process, process.name)),
  };
}

function resolvePm2OutLogPath(): string | null {
  try {
    const info = execSync(`pm2 info ${PM2_PROCESS_NAME} --no-color 2>/dev/null`, {
      encoding: "utf-8",
    });
    const line = info
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.includes("out log path"));
    const logPath = line?.split("│").pop()?.trim();
    return logPath || null;
  } catch {
    return null;
  }
}

function normalizeRootSearchStart(startPath: string | null | undefined): string | null {
  const trimmed = startPath?.trim();
  if (!trimmed) return null;

  try {
    const realPath = realpathSync(trimmed);
    return statSync(realPath).isDirectory() ? realPath : dirname(realPath);
  } catch {
    return trimmed;
  }
}

function isRaviProjectRoot(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.name === "ravi.bot" || pkg.name === "@filipelabs/ravi";
  } catch {
    return false;
  }
}

function findRaviProjectRootFrom(startPath: string | null | undefined): string | null {
  let dir = normalizeRootSearchStart(startPath);
  while (dir) {
    if (isRaviProjectRoot(dir)) return dir;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function findSourceProjectRoot(options: SourceProjectRootLookupOptions = {}): string | null {
  const candidates = [options.configuredPath ?? process.env.RAVI_REPO, options.cwd ?? process.cwd()];

  for (const candidate of candidates) {
    const root = findRaviProjectRootFrom(candidate);
    if (root) return root;
  }

  return null;
}

function resolveExistingFile(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  try {
    const realPath = realpathSync(trimmed);
    return statSync(realPath).isFile() ? realPath : null;
  } catch {
    return null;
  }
}

export function resolveDaemonRuntimeTarget(options: DaemonRuntimeTargetOptions = {}): DaemonRuntimeTarget | null {
  if (options.build) {
    const sourceProjectRoot = findSourceProjectRoot(options);
    if (!sourceProjectRoot) return null;

    return {
      bundlePath: join(sourceProjectRoot, "dist", "bundle", "index.js"),
      cwd: sourceProjectRoot,
      sourceProjectRoot,
    };
  }

  const bundlePath = resolveExistingFile(
    options.configuredBundle ?? process.env.RAVI_BUNDLE ?? options.argvEntry ?? process.argv[1],
  );
  if (!bundlePath) return null;

  const inferredProjectRoot = findRaviProjectRootFrom(bundlePath);

  return {
    bundlePath,
    cwd: options.daemonCwd?.trim() || process.env.RAVI_DAEMON_CWD?.trim() || inferredProjectRoot || homedir(),
  };
}

function requirePm2() {
  if (!isPm2Available()) {
    fail("PM2 not found. Install it: bun add -g pm2");
  }
}

@Group({
  name: "daemon",
  description: "Manage ravi via PM2",
  scope: "admin",
})
export class DaemonCommands {
  @Command({ name: "start", description: "Start the daemon via PM2" })
  start(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    requirePm2();

    if (isRaviRunning()) {
      if (asJson) {
        const payload = {
          action: "start",
          changed: false,
          reason: "already_running",
          status: buildDaemonStatusJson(),
        };
        printJson(payload);
        return payload;
      }
      console.log("Daemon is already running");
      console.log(`PID: ${getRaviPid()}`);
      return;
    }

    // Clean up old launchd/systemd if present
    this.cleanupLegacyServices({ silent: Boolean(asJson) });

    const target = this.requireRuntimeTarget();

    const args = [
      "start",
      target.bundlePath,
      "--name",
      PM2_PROCESS_NAME,
      "--interpreter",
      "bun",
      "--",
      "daemon",
      "run",
    ];
    const { status } = asJson ? runPm2Quiet(args, { cwd: target.cwd }) : runPm2(args, undefined, { cwd: target.cwd });

    if (asJson) {
      const payload = {
        action: "start",
        changed: status === 0,
        pm2Status: status,
        target,
        status: buildDaemonStatusJson(),
      };
      printJson(payload);
      if (status !== 0) fail("Failed to start daemon");
      return payload;
    }

    if (status === 0) {
      console.log("Daemon started via PM2");
    } else {
      fail("Failed to start daemon");
    }
  }

  @Command({ name: "stop", description: "Stop the daemon" })
  stop(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    requirePm2();

    if (!isRaviRunning()) {
      if (asJson) {
        const payload = {
          action: "stop",
          changed: false,
          reason: "not_running",
          status: buildDaemonStatusJson(),
        };
        printJson(payload);
        return payload;
      }
      console.log("Daemon is not running");
      return;
    }

    const { status } = asJson ? runPm2Quiet(["delete", PM2_PROCESS_NAME]) : runPm2(["delete", PM2_PROCESS_NAME]);
    if (asJson) {
      const payload = {
        action: "stop",
        changed: status === 0,
        pm2Status: status,
        status: buildDaemonStatusJson(),
      };
      printJson(payload);
      if (status !== 0) fail("Failed to stop daemon");
      return payload;
    }

    if (status === 0) {
      console.log("Daemon stopped");
    } else {
      fail("Failed to stop daemon");
    }
  }

  @Command({ name: "restart", description: "Restart the daemon" })
  restart(
    @Option({ flags: "-m, --message <msg>", description: "Restart reason to notify main agent" }) message?: string,
    @Option({ flags: "-b, --build", description: "Run build before restarting (dev mode)" }) build?: boolean,
    @Option({ flags: "-f, --force", description: "Bypass safety checks (active tasks)" }) force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    requirePm2();

    // Safety check: block restart if tasks are actively running
    if (!force) {
      try {
        const { dbGetActiveTasksBlocking } = require("../../tasks/task-db.js");
        const activeTasks = dbGetActiveTasksBlocking();
        if (activeTasks.length > 0) {
          const summary = activeTasks
            .slice(0, 5)
            .map(
              (t: { id: string; title: string; status: string; assigneeAgentId?: string }) =>
                `  - ${t.id} "${t.title}" (${t.status}, agent: ${t.assigneeAgentId || "none"})`,
            )
            .join("\n");
          const extra = activeTasks.length > 5 ? `\n  ... e mais ${activeTasks.length - 5} tasks` : "";
          fail(
            `Restart bloqueado: ${activeTasks.length} task(s) em andamento.\n\n` +
              `${summary}${extra}\n\n` +
              `O restart mata todas as sessões ativas e interrompe o trabalho em andamento.\n` +
              `Aguarde as tasks terminarem ou use --force para ignorar esta verificação.`,
          );
        }
      } catch {
        // If task DB is unavailable (e.g. outside daemon), skip check
      }
    }

    // When called inside daemon, spawn detached restart and return immediately
    if (hasContext()) {
      const target = this.requireRuntimeTarget({ build });
      if (!message) {
        fail('Flag -m é obrigatória quando chamado pelo Ravi. Use: ravi daemon restart -m "motivo"');
      }

      // Save restart reason with session context
      mkdirSync(RAVI_DIR, { recursive: true });
      const sessionName = process.env.RAVI_SESSION_NAME;
      const restartData = JSON.stringify({ reason: message, sessionName });
      writeFileSync(RESTART_REASON_FILE, restartData);

      // Spawn detached process to do the actual restart
      const args = [target.bundlePath, "daemon", "restart"];
      if (build) args.push("--build");
      if (force) args.push("--force");

      const cleanEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("RAVI_")) delete cleanEnv[key];
      }
      cleanEnv.RAVI_BUNDLE = target.bundlePath;
      cleanEnv.RAVI_DAEMON_CWD = target.cwd;

      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: "ignore",
        cwd: target.cwd,
        env: cleanEnv,
      });
      child.unref();

      if (asJson) {
        const payload = {
          action: "restart",
          mode: "detached",
          scheduled: true,
          changed: true,
          message,
          build: Boolean(build),
          force: Boolean(force),
          target,
          sessionName,
        };
        printJson(payload);
        return payload;
      }

      console.log("Restart scheduled (detached)");
      return;
    }

    // Build first if requested
    const target = this.requireRuntimeTarget({ build });
    let buildResult: { requested: boolean; ok: boolean } = { requested: Boolean(build), ok: true };
    if (build) {
      if (!asJson) console.log("Building...");
      try {
        execSync("bun run build", {
          stdio: asJson ? ["ignore", "pipe", "pipe"] : "inherit",
          cwd: target.cwd,
        });
        if (!asJson) console.log("Build completed");
      } catch {
        buildResult = { requested: true, ok: false };
        if (asJson) {
          const payload = {
            action: "restart",
            changed: false,
            build: buildResult,
            force: Boolean(force),
            message: message ?? null,
            target,
            status: buildDaemonStatusJson(),
          };
          printJson(payload);
        }
        fail("Build failed, aborting restart");
      }
    }

    // Save restart reason if provided
    if (message) {
      mkdirSync(RAVI_DIR, { recursive: true });
      writeFileSync(RESTART_REASON_FILE, message);
    }

    let pm2Status = 0;
    const previousRunning = isRaviRunning();
    if (isRaviRunning()) {
      const stop = asJson ? runPm2Quiet(["delete", PM2_PROCESS_NAME]) : runPm2(["delete", PM2_PROCESS_NAME]);
      pm2Status = stop.status;
      if (stop.status !== 0) {
        fail("Failed to stop daemon before restart");
      }

      const args = [
        "start",
        target.bundlePath,
        "--name",
        PM2_PROCESS_NAME,
        "--interpreter",
        "bun",
        "--",
        "daemon",
        "run",
      ];
      const { status } = asJson ? runPm2Quiet(args, { cwd: target.cwd }) : runPm2(args, undefined, { cwd: target.cwd });
      pm2Status = status;
      if (asJson) {
        const payload = {
          action: "restart",
          changed: status === 0,
          previousRunning,
          pm2Status,
          build: buildResult,
          force: Boolean(force),
          message: message ?? null,
          target,
          status: buildDaemonStatusJson(),
        };
        printJson(payload);
        if (status !== 0) fail("Failed to restart daemon");
        return payload;
      }
      if (status === 0) {
        console.log("Daemon restarted");
      } else {
        fail("Failed to restart daemon");
      }
    } else {
      if (asJson) {
        const args = [
          "start",
          target.bundlePath,
          "--name",
          PM2_PROCESS_NAME,
          "--interpreter",
          "bun",
          "--",
          "daemon",
          "run",
        ];
        const { status } = runPm2Quiet(args, { cwd: target.cwd });
        const payload = {
          action: "restart",
          changed: status === 0,
          previousRunning,
          pm2Status: status,
          build: buildResult,
          force: Boolean(force),
          message: message ?? null,
          target,
          status: buildDaemonStatusJson(),
        };
        printJson(payload);
        if (status !== 0) fail("Failed to restart daemon");
        return payload;
      }
      this.start();
    }
  }

  @Command({ name: "status", description: "Show daemon and infrastructure status" })
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    if (asJson) {
      const payload = buildDaemonStatusJson();
      printJson(payload);
      return payload;
    }

    if (!isPm2Available()) {
      console.log("\nPM2 not installed. Install: bun add -g pm2\n");
      return;
    }

    const procs = getPm2Processes();
    const ravi = procs.find((p) => p.name === PM2_PROCESS_NAME);
    const omniApi = procs.find((p) => p.name === "omni-api");
    const omniNats = procs.find((p) => p.name === "omni-nats");

    console.log("\nRavi Daemon Status");
    console.log("──────────────────");

    if (ravi) {
      const mem = (ravi.memory / 1024 / 1024).toFixed(1);
      console.log(`  ravi:      ${ravi.status === "online" ? "online" : ravi.status}  (PID ${ravi.pid}, ${mem}MB)`);
    } else {
      console.log("  ravi:      stopped");
    }

    if (omniNats) {
      console.log(`  omni-nats: ${omniNats.status === "online" ? "online" : omniNats.status}  (PID ${omniNats.pid})`);
    } else {
      console.log("  omni-nats: not managed by PM2");
    }

    if (omniApi) {
      const mem = (omniApi.memory / 1024 / 1024).toFixed(1);
      console.log(
        `  omni-api:  ${omniApi.status === "online" ? "online" : omniApi.status}  (PID ${omniApi.pid}, ${mem}MB)`,
      );
    } else {
      console.log("  omni-api:  not managed by PM2");
    }

    console.log();
  }

  @Command({ name: "logs", description: "Show daemon logs (PM2)" })
  logs(
    @Option({ flags: "-f, --follow", description: "Follow log output" }) follow?: boolean,
    @Option({ flags: "-t, --tail <lines>", description: "Number of lines to show", defaultValue: "50" }) tail?: string,
    @Option({ flags: "--clear", description: "Flush PM2 logs for ravi" }) clear?: boolean,
    @Option({ flags: "--path", description: "Print PM2 log file path" }) path?: boolean,
    @Option({ flags: "--json", description: "Print structured log result; with --follow, print JSONL records" })
    asJson?: boolean,
  ) {
    requirePm2();

    if (path) {
      const logPath = resolvePm2OutLogPath();
      if (asJson) {
        const payload = {
          action: "logs",
          process: PM2_PROCESS_NAME,
          path: logPath,
          available: Boolean(logPath),
        };
        printJson(payload);
        return payload;
      }
      console.log(logPath || "Run 'pm2 info ravi' to find log path");
      return;
    }

    if (clear) {
      const result = asJson ? runPm2Quiet(["flush", PM2_PROCESS_NAME]) : runPm2(["flush", PM2_PROCESS_NAME]);
      if (asJson) {
        const payload = {
          action: "flush-logs",
          changed: result.status === 0,
          pm2Status: result.status,
          process: PM2_PROCESS_NAME,
        };
        printJson(payload);
        return payload;
      }
      console.log("Logs flushed");
      return;
    }

    const lines = tail || "50";
    const args = ["logs", PM2_PROCESS_NAME, "--lines", lines];
    if (!follow) args.push("--nostream");

    if (asJson && !follow) {
      const result = capturePm2(args);
      const records = [
        ...result.stdout
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => ({ stream: "stdout", line })),
        ...result.stderr
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => ({ stream: "stderr", line })),
      ];
      const payload = {
        action: "logs",
        process: PM2_PROCESS_NAME,
        follow: false,
        tail: lines,
        pm2Status: result.status,
        records,
      };
      printJson(payload);
      return payload;
    }

    if (asJson && follow) {
      const child = spawn("pm2", args, { stdio: ["ignore", "pipe", "pipe"] });
      const emitLines = (stream: NodeJS.ReadableStream | null, streamName: "stdout" | "stderr") => {
        if (!stream) return;
        let buffer = "";
        stream.on("data", (chunk: Buffer | string) => {
          buffer += chunk.toString();
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            printJsonl({
              type: "daemon.log",
              time: new Date().toISOString(),
              process: PM2_PROCESS_NAME,
              stream: streamName,
              line,
            });
          }
        });
        stream.on("end", () => {
          if (!buffer) return;
          printJsonl({
            type: "daemon.log",
            time: new Date().toISOString(),
            process: PM2_PROCESS_NAME,
            stream: streamName,
            line: buffer,
          });
        });
      };

      emitLines(child.stdout, "stdout");
      emitLines(child.stderr, "stderr");
      process.on("SIGINT", () => {
        child.kill();
        process.exit(0);
      });
      child.on("close", (code) => {
        printJsonl({
          type: "daemon.logs_closed",
          time: new Date().toISOString(),
          process: PM2_PROCESS_NAME,
          code: code ?? 0,
        });
        process.exit(code || 0);
      });
      return;
    }

    const child = spawn("pm2", args, { stdio: "inherit" });

    if (follow) {
      process.on("SIGINT", () => {
        child.kill();
        process.exit(0);
      });
    }

    child.on("close", (code) => {
      process.exit(code || 0);
    });
  }

  @Command({ name: "install", description: "Save PM2 process list and suggest startup" })
  install(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    requirePm2();
    const result = asJson ? runPm2Quiet(["save"]) : runPm2(["save"]);
    if (asJson) {
      const payload = {
        action: "install",
        changed: result.status === 0,
        pm2Status: result.status,
        startupCommand: "pm2 startup",
      };
      printJson(payload);
      return payload;
    }
    console.log("\nPM2 process list saved.");
    console.log("To start on boot, run: pm2 startup");
  }

  @Command({ name: "uninstall", description: "Remove ravi from PM2 and clean up" })
  uninstall(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    requirePm2();

    const wasRunning = isRaviRunning();
    let deleteStatus: number | null = null;
    if (isRaviRunning()) {
      const result = asJson ? runPm2Quiet(["delete", PM2_PROCESS_NAME]) : runPm2(["delete", PM2_PROCESS_NAME]);
      deleteStatus = result.status;
    }
    const saveResult = asJson ? runPm2Quiet(["save"]) : runPm2(["save"]);

    // Clean up old launchd/systemd if present
    this.cleanupLegacyServices({ silent: Boolean(asJson) });

    if (asJson) {
      const payload = {
        action: "uninstall",
        changed: wasRunning || saveResult.status === 0,
        wasRunning,
        deleteStatus,
        saveStatus: saveResult.status,
        status: buildDaemonStatusJson(),
      };
      printJson(payload);
      return payload;
    }

    console.log("Ravi removed from PM2");
  }

  @Command({ name: "run", description: "Run daemon in foreground (used by PM2)" })
  async run() {
    const { startDaemon } = await import("../../daemon.js");
    await startDaemon();
  }

  @Command({ name: "dev", description: "Run daemon in dev mode with auto-rebuild on file changes" })
  async dev() {
    const projectRoot = this.requireSourceProjectRoot();

    console.log(`Dev mode - watching ${projectRoot}/src`);
    console.log("Auto-rebuild on changes. Use 'ravi daemon restart' to apply.\n");
    console.log("Press Ctrl+C to stop\n");

    // Initial build
    console.log("Building...");
    try {
      execSync("bun run build", { stdio: "inherit", cwd: projectRoot });
      console.log("Build completed\n");
    } catch {
      fail("Initial build failed");
    }

    const rebuild = () => {
      console.log("\nRebuilding...");
      try {
        execSync("bun run build", { stdio: "inherit", cwd: projectRoot });
        console.log("Build completed - run 'ravi daemon restart' to apply");
      } catch {
        console.error("Build failed");
      }
    };

    // Watch for file changes using native fs.watch
    const { watch } = await import("node:fs");
    const { resolve } = await import("node:path");
    const srcDir = resolve(projectRoot, "src");

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debounceMs = 500;

    const watchDir = (dir: string) => {
      try {
        watch(dir, { recursive: true }, (_eventType, filename) => {
          if (!filename || !filename.endsWith(".ts")) return;

          const normalizedPath = filename.replace(/\\/g, "/");
          const ignoredFiles = ["cli/commands/index.ts", "plugins/internal-registry.ts"];
          if (ignoredFiles.some((f) => normalizedPath === f || normalizedPath.endsWith(`/${f}`))) {
            return;
          }

          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            console.log(`\nChanged: ${filename}`);
            rebuild();
          }, debounceMs);
        });
      } catch (err) {
        console.error(`Failed to watch ${dir}:`, err);
      }
    };

    watchDir(srcDir);
    console.log(`Watching ${srcDir} for changes...\n`);

    process.on("SIGINT", () => {
      console.log("\n\nStopping dev mode...");
      process.exit(0);
    });

    await new Promise(() => {});
  }

  @Command({ name: "env", description: "Edit environment file (~/.ravi/.env)" })
  env(@Option({ flags: "--json", description: "Print raw JSON result without opening an editor" }) asJson?: boolean) {
    mkdirSync(RAVI_DIR, { recursive: true });

    const existedBefore = existsSync(ENV_FILE);
    if (!existsSync(ENV_FILE)) {
      const defaultEnv = `# Ravi Daemon Environment
# This file is loaded when the daemon starts.
# Edit and restart the daemon for changes to take effect.

# Required (one of these)
ANTHROPIC_API_KEY=
# CLAUDE_CODE_OAUTH_TOKEN=

# NATS connection (default: nats://127.0.0.1:4222)
# NATS_URL=nats://127.0.0.1:4222

# Omni overrides (default: read from ~/.omni/config.json)
# OMNI_API_URL=http://127.0.0.1:8882
# OMNI_API_KEY=

# Optional
# OPENAI_API_KEY=
# RAVI_MODEL=sonnet
# RAVI_LOG_LEVEL=info
`;
      writeFileSync(ENV_FILE, defaultEnv);
      if (!asJson) {
        console.log(`Created ${ENV_FILE}`);
      }
    }

    if (asJson) {
      const payload = {
        action: "env",
        path: ENV_FILE,
        existedBefore,
        created: !existedBefore,
        openedEditor: false,
      };
      printJson(payload);
      return payload;
    }

    const editor = process.env.EDITOR || "nano";
    try {
      execSync(`${editor} ${ENV_FILE}`, { stdio: "inherit" });
    } catch {
      console.log(`Edit the file manually: ${ENV_FILE}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private requireRuntimeTarget(options: { build?: boolean } = {}): DaemonRuntimeTarget {
    const target = resolveDaemonRuntimeTarget(options);
    if (!target) {
      fail(
        options.build
          ? "Could not resolve source build target. Set RAVI_REPO or run from the Ravi source repo after building."
          : "Could not resolve Ravi runtime bundle. Reinstall ravi.bot or set RAVI_BUNDLE.",
      );
    }
    return target;
  }

  private requireSourceProjectRoot(): string {
    const projectRoot = this.findSourceProjectRoot();
    if (!projectRoot) {
      fail("Could not find source project root (package.json with ravi.bot). Set RAVI_REPO or run from the repo.");
    }
    return projectRoot;
  }

  private findSourceProjectRoot(): string | null {
    return findSourceProjectRoot();
  }

  /**
   * Remove old launchd plist or systemd unit if they exist.
   */
  private cleanupLegacyServices(options: { silent?: boolean } = {}) {
    const plistPath = join(homedir(), "Library/LaunchAgents/sh.ravi.daemon.plist");
    const systemdPath = "/etc/systemd/system/ravi.service";

    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "pipe" });
      } catch {
        /* ignore */
      }
      try {
        const { unlinkSync } = require("node:fs");
        unlinkSync(plistPath);
        if (!options.silent) {
          console.log("Removed old launchd service");
        }
      } catch {
        /* ignore */
      }
    }

    if (existsSync(systemdPath)) {
      try {
        execSync("sudo systemctl stop ravi 2>/dev/null", { stdio: "pipe" });
        execSync("sudo systemctl disable ravi 2>/dev/null", { stdio: "pipe" });
        execSync(`sudo rm ${systemdPath} 2>/dev/null`, { stdio: "pipe" });
        execSync("sudo systemctl daemon-reload 2>/dev/null", { stdio: "pipe" });
        if (!options.silent) {
          console.log("Removed old systemd service");
        }
      } catch {
        /* ignore */
      }
    }
  }
}

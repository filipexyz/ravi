/**
 * Daemon Commands - Manage ravi via PM2
 */

import "reflect-metadata";
import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Group, Command, Option } from "../decorators.js";
import { hasContext, fail } from "../context.js";
import { isPm2Available, runPm2, isRaviRunning, getRaviPid, getPm2Processes, PM2_PROCESS_NAME } from "../../pm2.js";

const RAVI_DIR = join(homedir(), ".ravi");
const ENV_FILE = join(RAVI_DIR, ".env");
const RESTART_REASON_FILE = join(RAVI_DIR, "restart-reason.txt");

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
  start() {
    requirePm2();

    if (isRaviRunning()) {
      console.log("Daemon is already running");
      console.log(`PID: ${getRaviPid()}`);
      return;
    }

    // Clean up old launchd/systemd if present
    this.cleanupLegacyServices();

    const bundlePath = this.findBundlePath();
    if (!bundlePath) {
      fail("Bundle not found. Run: bun run build");
    }

    const { status } = runPm2([
      "start",
      bundlePath,
      "--name",
      PM2_PROCESS_NAME,
      "--interpreter",
      "bun",
      "--",
      "daemon",
      "run",
    ]);

    if (status === 0) {
      console.log("Daemon started via PM2");
    } else {
      fail("Failed to start daemon");
    }
  }

  @Command({ name: "stop", description: "Stop the daemon" })
  stop() {
    requirePm2();

    if (!isRaviRunning()) {
      console.log("Daemon is not running");
      return;
    }

    const { status } = runPm2(["delete", PM2_PROCESS_NAME]);
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
  ) {
    requirePm2();

    // When called inside daemon, spawn detached restart and return immediately
    if (hasContext()) {
      if (!message) {
        fail('Flag -m é obrigatória quando chamado pelo Ravi. Use: ravi daemon restart -m "motivo"');
      }

      // Save restart reason with session context
      mkdirSync(RAVI_DIR, { recursive: true });
      const sessionName = process.env.RAVI_SESSION_NAME;
      const restartData = JSON.stringify({ reason: message, sessionName });
      writeFileSync(RESTART_REASON_FILE, restartData);

      // Spawn detached process to do the actual restart
      const args = ["daemon", "restart"];
      if (build) args.push("--build");

      const cleanEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith("RAVI_")) delete cleanEnv[key];
      }

      const child = spawn("ravi", args, {
        detached: true,
        stdio: "ignore",
        cwd: this.findProjectRoot() ?? undefined,
        env: cleanEnv,
      });
      child.unref();

      console.log("Restart scheduled (detached)");
      return;
    }

    // Build first if requested
    if (build) {
      console.log("Building...");
      try {
        execSync("bun run build", {
          stdio: "inherit",
          cwd: this.findProjectRoot() ?? undefined,
        });
        console.log("Build completed");
      } catch {
        fail("Build failed, aborting restart");
      }
    }

    // Save restart reason if provided
    if (message) {
      mkdirSync(RAVI_DIR, { recursive: true });
      writeFileSync(RESTART_REASON_FILE, message);
    }

    if (isRaviRunning()) {
      const { status } = runPm2(["restart", PM2_PROCESS_NAME]);
      if (status === 0) {
        console.log("Daemon restarted");
      } else {
        fail("Failed to restart daemon");
      }
    } else {
      this.start();
    }
  }

  @Command({ name: "status", description: "Show daemon and infrastructure status" })
  status() {
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
  ) {
    requirePm2();

    if (path) {
      try {
        const info = execSync(`pm2 info ${PM2_PROCESS_NAME} --no-color 2>/dev/null | grep "out log path"`, {
          encoding: "utf-8",
        }).trim();
        const logPath = info.split("│").pop()?.trim();
        console.log(logPath || "Run 'pm2 info ravi' to find log path");
      } catch {
        console.log("Run 'pm2 info ravi' to find log path");
      }
      return;
    }

    if (clear) {
      runPm2(["flush", PM2_PROCESS_NAME]);
      console.log("Logs flushed");
      return;
    }

    const lines = tail || "50";
    const args = ["logs", PM2_PROCESS_NAME, "--lines", lines];
    if (!follow) args.push("--nostream");

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
  install() {
    requirePm2();
    runPm2(["save"]);
    console.log("\nPM2 process list saved.");
    console.log("To start on boot, run: pm2 startup");
  }

  @Command({ name: "uninstall", description: "Remove ravi from PM2 and clean up" })
  uninstall() {
    requirePm2();

    if (isRaviRunning()) {
      runPm2(["delete", PM2_PROCESS_NAME]);
    }
    runPm2(["save"]);

    // Clean up old launchd/systemd if present
    this.cleanupLegacyServices();

    console.log("Ravi removed from PM2");
  }

  @Command({ name: "run", description: "Run daemon in foreground (used by PM2)" })
  async run() {
    const { startDaemon } = await import("../../daemon.js");
    await startDaemon();
  }

  @Command({ name: "dev", description: "Run daemon in dev mode with auto-rebuild on file changes" })
  async dev() {
    const projectRoot = this.findProjectRoot();
    if (!projectRoot) {
      fail("Could not find project root (package.json with ravi.bot)");
    }

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
  env() {
    mkdirSync(RAVI_DIR, { recursive: true });

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
      console.log(`Created ${ENV_FILE}`);
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

  private findBundlePath(): string | null {
    // Try known locations
    const locations = [join(this.findProjectRoot() ?? "", "dist", "bundle", "index.js")];

    for (const loc of locations) {
      if (existsSync(loc)) return loc;
    }

    return null;
  }

  private findProjectRoot(): string | null {
    const knownPath = "/Users/luis/dev/filipelabs/ravi.bot";
    if (existsSync(join(knownPath, "package.json"))) {
      return knownPath;
    }

    let dir = process.cwd();
    while (dir !== "/") {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          if (pkg.name === "ravi.bot" || pkg.name === "@filipelabs/ravi") {
            return dir;
          }
        } catch {
          // ignore
        }
      }
      dir = join(dir, "..");
    }

    return knownPath;
  }

  /**
   * Remove old launchd plist or systemd unit if they exist.
   */
  private cleanupLegacyServices() {
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
        console.log("Removed old launchd service");
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
        console.log("Removed old systemd service");
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Daemon Commands - Manage bot + gateway as system services
 */

import "reflect-metadata";
import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { Group, Command, Option } from "../decorators.js";

const RAVI_DIR = join(homedir(), ".ravi");
const PID_FILE = join(RAVI_DIR, "daemon.pid");
const LOG_FILE = join(RAVI_DIR, "logs", "daemon.log");
const ENV_FILE = join(RAVI_DIR, ".env");

// launchd plist path (macOS)
const PLIST_PATH = join(homedir(), "Library/LaunchAgents/sh.ravi.daemon.plist");

// systemd service path (Linux) - system-level, not user
const SYSTEMD_PATH = "/etc/systemd/system/ravi.service";

const IS_MACOS = platform() === "darwin";
const IS_LINUX = platform() === "linux";

@Group({
  name: "daemon",
  description: "Manage bot + gateway as system service",
})
export class DaemonCommands {
  @Command({ name: "start", description: "Start the daemon (bot + gateway)" })
  start() {
    if (this.isRunning()) {
      console.log("Daemon is already running");
      console.log(`PID: ${this.getPid()}`);
      return;
    }

    if (IS_MACOS) {
      this.startMacOS();
    } else if (IS_LINUX) {
      this.startLinux();
    } else {
      this.startDirect();
    }
  }

  @Command({ name: "stop", description: "Stop the daemon" })
  stop() {
    if (!this.isRunning()) {
      console.log("Daemon is not running");
      return;
    }

    if (IS_MACOS) {
      this.stopMacOS();
    } else if (IS_LINUX) {
      this.stopLinux();
    } else {
      this.stopDirect();
    }
  }

  @Command({ name: "restart", description: "Restart the daemon" })
  restart() {
    if (this.isRunning()) {
      this.stop();
      // Wait for the old process to fully die before starting new one
      const deadline = Date.now() + 15000;
      process.stdout.write("Waiting for daemon to stop");
      while (Date.now() < deadline) {
        if (!this.isRunning()) {
          console.log(" done");
          break;
        }
        process.stdout.write(".");
        try { execSync("sleep 0.5", { stdio: "pipe" }); } catch {}
      }
      if (this.isRunning()) {
        console.warn("\nWarning: old daemon still running, forcing start anyway");
      }
    }
    this.start();
  }

  @Command({ name: "status", description: "Show daemon status" })
  status() {
    const running = this.isRunning();
    const pid = this.getPid();

    console.log(`\nRavi Daemon Status`);
    console.log(`──────────────────`);
    console.log(`  Status: ${running ? "✓ Running" : "✗ Stopped"}`);
    if (pid) {
      console.log(`  PID:    ${pid}`);
    }
    console.log(`  Log:    ${LOG_FILE}`);
    console.log();

    if (IS_MACOS) {
      console.log(`  Type:   launchd`);
      console.log(`  Plist:  ${PLIST_PATH}`);
    } else if (IS_LINUX) {
      console.log(`  Type:   systemd (system)`);
      console.log(`  Unit:   ${SYSTEMD_PATH}`);
    } else {
      console.log(`  Type:   direct (no service manager)`);
    }
  }

  @Command({ name: "logs", description: "Show daemon logs" })
  logs(
    @Option({ flags: "-f, --follow", description: "Follow log output" }) follow?: boolean,
    @Option({ flags: "-t, --tail <lines>", description: "Number of lines to show", defaultValue: "50" }) tail?: string,
    @Option({ flags: "--clear", description: "Clear log file" }) clear?: boolean,
    @Option({ flags: "--path", description: "Print log file path only" }) path?: boolean
  ) {
    // Just print path
    if (path) {
      console.log(LOG_FILE);
      return;
    }

    // Clear logs
    if (clear) {
      if (existsSync(LOG_FILE)) {
        writeFileSync(LOG_FILE, "");
        console.log("✓ Logs cleared");
      } else {
        console.log("No logs to clear");
      }
      return;
    }

    if (!existsSync(LOG_FILE)) {
      console.log("No logs yet. Start the daemon first.");
      return;
    }

    const lines = parseInt(tail || "50", 10);

    if (follow) {
      console.log(`Following ${LOG_FILE} (Ctrl+C to stop)\n`);
      const child = spawn("tail", ["-n", String(lines), "-f", LOG_FILE], {
        stdio: "inherit",
      });

      process.on("SIGINT", () => {
        child.kill();
        process.exit(0);
      });
    } else {
      // Just show last N lines
      const child = spawn("tail", ["-n", String(lines), LOG_FILE], {
        stdio: "inherit",
      });

      child.on("close", (code) => {
        process.exit(code || 0);
      });
    }
  }

  @Command({ name: "install", description: "Install system service (launchd/systemd)" })
  install() {
    if (IS_MACOS) {
      this.installMacOS();
    } else if (IS_LINUX) {
      this.installLinux();
    } else {
      console.log("System service not supported on this platform.");
      console.log("Use 'ravi daemon start' to run directly.");
    }
  }

  @Command({ name: "uninstall", description: "Uninstall system service" })
  uninstall() {
    if (IS_MACOS) {
      this.uninstallMacOS();
    } else if (IS_LINUX) {
      this.uninstallLinux();
    } else {
      console.log("No system service installed.");
    }
  }

  @Command({ name: "run", description: "Run daemon in foreground (used by system services)" })
  async run() {
    const { startDaemon } = await import("../../daemon.js");
    await startDaemon();
  }

  @Command({ name: "env", description: "Edit environment file (~/.ravi/.env)" })
  env() {
    // Ensure directory exists
    mkdirSync(RAVI_DIR, { recursive: true });

    // Create default .env if it doesn't exist
    if (!existsSync(ENV_FILE)) {
      const defaultEnv = `# Ravi Daemon Environment
# This file is loaded when the daemon starts.
# Edit and restart the daemon for changes to take effect.

# Required
NOTIF_API_KEY=
ANTHROPIC_API_KEY=

# Optional
# RAVI_MODEL=sonnet
# RAVI_LOG_LEVEL=info
`;
      writeFileSync(ENV_FILE, defaultEnv);
      console.log(`Created ${ENV_FILE}`);
    }

    // Open in editor
    const editor = process.env.EDITOR || "nano";
    try {
      execSync(`${editor} ${ENV_FILE}`, { stdio: "inherit" });
    } catch {
      console.log(`Edit the file manually: ${ENV_FILE}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // macOS (launchd)
  // ──────────────────────────────────────────────────────────────────────────

  private installMacOS() {
    const raviBin = this.findRaviBin();

    // Ensure logs directory exists
    mkdirSync(join(RAVI_DIR, "logs"), { recursive: true });

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.ravi.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${raviBin}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${homedir()}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>`;

    writeFileSync(PLIST_PATH, plist);
    console.log(`✓ Installed launchd service: ${PLIST_PATH}`);
    console.log(`\nEnvironment loaded from: ~/.ravi/.env`);
    console.log("To start: ravi daemon start");
  }

  private uninstallMacOS() {
    if (this.isRunning()) {
      this.stopMacOS();
    }

    if (existsSync(PLIST_PATH)) {
      unlinkSync(PLIST_PATH);
      console.log(`✓ Uninstalled launchd service`);
    } else {
      console.log("Service not installed.");
    }
  }

  private startMacOS() {
    if (!existsSync(PLIST_PATH)) {
      console.log("Service not installed. Installing...");
      this.installMacOS();
    }

    try {
      execSync(`launchctl load ${PLIST_PATH}`, { stdio: "inherit" });
      console.log("✓ Daemon started");
    } catch {
      console.error("Failed to start daemon");
    }
  }

  private stopMacOS() {
    try {
      execSync(`launchctl unload ${PLIST_PATH}`, { stdio: "inherit" });
      console.log("✓ Daemon stopped");
    } catch {
      console.error("Failed to stop daemon");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Linux (systemd)
  // ──────────────────────────────────────────────────────────────────────────

  private installLinux() {
    // Find the ravi binary
    const raviBin = this.findRaviBin();
    const currentUser = process.env.USER || process.env.LOGNAME || "ravi";

    // Ensure logs directory exists
    mkdirSync(join(RAVI_DIR, "logs"), { recursive: true });

    // Use a clean PATH (filter out Windows paths and invalid entries)
    const cleanPath = (process.env.PATH || "")
      .split(":")
      .filter(p => p.startsWith("/") && !p.includes("\\"))
      .join(":") || "/usr/local/bin:/usr/bin:/bin";

    const unit = `[Unit]
Description=Ravi Bot Daemon
After=network.target

[Service]
Type=simple
User=${currentUser}
Group=${currentUser}
ExecStart=${raviBin} daemon run
WorkingDirectory=${homedir()}
Restart=always
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
Environment=HOME=${homedir()}
Environment=PATH=${cleanPath}

[Install]
WantedBy=multi-user.target
`;

    // Write to temp file then move with sudo
    const tmpFile = join(RAVI_DIR, "ravi.service.tmp");
    writeFileSync(tmpFile, unit);

    try {
      execSync(`sudo mv ${tmpFile} ${SYSTEMD_PATH}`, { stdio: "inherit" });
      execSync("sudo systemctl daemon-reload", { stdio: "inherit" });
      console.log(`✓ Installed systemd service: ${SYSTEMD_PATH}`);
      console.log(`\nEnvironment loaded from: ~/.ravi/.env`);
      console.log("To start: ravi daemon start");
      console.log("To enable on boot: sudo systemctl enable ravi");
    } catch {
      // Clean up temp file
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      throw new Error("Failed to install service. Make sure you have sudo access.");
    }
  }

  private uninstallLinux() {
    if (this.isRunning()) {
      this.stopLinux();
    }

    try {
      execSync("sudo systemctl disable ravi", { stdio: "pipe" });
    } catch {
      // Ignore if not enabled
    }

    if (existsSync(SYSTEMD_PATH)) {
      execSync(`sudo rm ${SYSTEMD_PATH}`, { stdio: "inherit" });
      execSync("sudo systemctl daemon-reload", { stdio: "inherit" });
      console.log(`✓ Uninstalled systemd service`);
    } else {
      console.log("Service not installed.");
    }
  }

  private startLinux() {
    if (!existsSync(SYSTEMD_PATH)) {
      console.log("Service not installed. Installing...");
      this.installLinux();
    }

    try {
      execSync("sudo systemctl start ravi", { stdio: "inherit" });
      console.log("✓ Daemon started");
    } catch {
      console.error("Failed to start daemon");
    }
  }

  private stopLinux() {
    try {
      execSync("sudo systemctl stop ravi", { stdio: "inherit" });
      console.log("✓ Daemon stopped");
    } catch {
      console.error("Failed to stop daemon");
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Direct (fallback - no service manager)
  // ──────────────────────────────────────────────────────────────────────────

  private startDirect() {
    const raviBin = this.findRaviBin();
    const child = spawn(raviBin, ["daemon", "run"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: homedir(),
    });

    // Write PID
    writeFileSync(PID_FILE, String(child.pid));

    child.unref();
    console.log(`✓ Daemon started (PID: ${child.pid})`);
    console.log(`  Logs: ${LOG_FILE}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private findRaviBin(): string {
    // Try to find ravi in PATH
    try {
      const which = execSync("which ravi", { encoding: "utf-8" }).trim();
      if (which) return which;
    } catch {
      // Not in PATH
    }

    // Try common locations
    const locations = [
      join(homedir(), ".bun/bin/ravi"),
      join(homedir(), ".local/bin/ravi"),
      "/usr/local/bin/ravi",
      "/usr/bin/ravi",
    ];

    for (const loc of locations) {
      if (existsSync(loc)) return loc;
    }

    // Fallback to assuming it's in PATH
    return "ravi";
  }

  private stopDirect() {
    const pid = this.getPid();
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        if (existsSync(PID_FILE)) {
          unlinkSync(PID_FILE);
        }
        console.log("✓ Daemon stopped");
      } catch {
        console.error("Failed to stop daemon");
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  private isRunning(): boolean {
    if (IS_MACOS) {
      try {
        const result = execSync("launchctl list | grep sh.ravi.daemon", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return result.includes("sh.ravi.daemon");
      } catch {
        return false;
      }
    }

    if (IS_LINUX) {
      try {
        execSync("systemctl is-active ravi", { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    }

    // Direct mode - check PID
    const pid = this.getPid();
    if (!pid) return false;

    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getPid(): number | null {
    if (IS_MACOS) {
      try {
        const result = execSync("launchctl list | grep sh.ravi.daemon", {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        const parts = result.trim().split(/\s+/);
        const pid = parseInt(parts[0], 10);
        return isNaN(pid) ? null : pid;
      } catch {
        return null;
      }
    }

    if (IS_LINUX) {
      try {
        const result = execSync("systemctl show ravi --property=MainPID", {
          encoding: "utf-8",
        });
        const pid = parseInt(result.replace("MainPID=", "").trim(), 10);
        return pid > 0 ? pid : null;
      } catch {
        return null;
      }
    }

    // Direct mode
    if (!existsSync(PID_FILE)) return null;
    try {
      return parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    } catch {
      return null;
    }
  }
}

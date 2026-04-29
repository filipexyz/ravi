/**
 * Service Commands - Bot service management CLI
 */

import "reflect-metadata";
import { spawn } from "node:child_process";
import { Group, Command, Arg, Option } from "../decorators.js";

@Group({
  name: "service",
  description: "Bot service management",
  scope: "admin",
})
export class ServiceCommands {
  @Command({ name: "start", description: "Start the bot server" })
  start(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const command = "bun";
    const args = ["src/index.ts"];
    if (asJson) {
      const child = spawn(command, args, {
        stdio: "ignore",
        cwd: process.cwd(),
        detached: true,
      });
      child.unref();
      const payload = {
        success: true as const,
        service: "bot" as const,
        started: true as const,
        detached: true as const,
        pid: child.pid ?? null,
        command,
        args,
        cwd: process.cwd(),
      };
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }

    console.log("Starting Ravi bot server...");
    const child = spawn(command, args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", (err) => {
      console.error(`Failed to start: ${err.message}`);
      process.exit(1);
    });
    return {
      success: true as const,
      service: "bot" as const,
      started: true as const,
      detached: false as const,
      pid: child.pid ?? null,
      command,
      args,
      cwd: process.cwd(),
    };
  }

  @Command({ name: "tui", description: "Start the TUI interface" })
  tui(
    @Arg("session", {
      required: false,
      description: "Session key (default: agent:main:main)",
    })
    session?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const args = ["src/tui.tsx"];
    if (session) args.push(session);

    if (asJson) {
      const payload = {
        success: false as const,
        service: "tui" as const,
        started: false as const,
        supported: false as const,
        reason:
          "TUI uses inherited interactive stdio; JSON mode does not launch it to keep stdout valid JSON." as const,
        command: "bun" as const,
        args,
        cwd: process.cwd(),
      };
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }

    console.log(`Starting TUI${session ? ` with session: ${session}` : ""}...`);
    const child = spawn("bun", args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", (err) => {
      console.error(`Failed to start TUI: ${err.message}`);
      process.exit(1);
    });
    return {
      success: true as const,
      service: "tui" as const,
      started: true as const,
      supported: true as const,
      pid: child.pid ?? null,
      command: "bun" as const,
      args,
      cwd: process.cwd(),
    };
  }

  @Command({ name: "wa", description: "Start WhatsApp gateway (deprecated — use daemon start)" })
  wa(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const payload = {
      success: true,
      deprecated: true,
      service: "whatsapp",
      managedBy: "omni",
      replacementCommand: "ravi daemon start",
      message: "WhatsApp is now managed by the omni process.",
    };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log("Note: WhatsApp is now managed by the omni process.");
      console.log("Use 'ravi daemon start' to start all services including WhatsApp.");
    }
    return payload;
  }
}

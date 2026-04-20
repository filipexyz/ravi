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
      console.log(
        JSON.stringify(
          {
            success: true,
            service: "bot",
            started: true,
            detached: true,
            pid: child.pid,
            command,
            args,
            cwd: process.cwd(),
          },
          null,
          2,
        ),
      );
      return;
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
      console.log(
        JSON.stringify(
          {
            success: false,
            service: "tui",
            started: false,
            supported: false,
            reason: "TUI uses inherited interactive stdio; JSON mode does not launch it to keep stdout valid JSON.",
            command: "bun",
            args,
            cwd: process.cwd(),
          },
          null,
          2,
        ),
      );
      return;
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

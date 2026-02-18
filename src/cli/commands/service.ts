/**
 * Service Commands - Bot service management CLI
 */

import "reflect-metadata";
import { spawn } from "node:child_process";
import { Group, Command, Arg } from "../decorators.js";

@Group({
  name: "service",
  description: "Bot service management",
  scope: "admin",
})
export class ServiceCommands {
  @Command({ name: "start", description: "Start the bot server" })
  start() {
    console.log("Starting Ravi bot server...");
    const child = spawn("bun", ["src/index.ts"], {
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
    session?: string
  ) {
    const args = ["src/tui.tsx"];
    if (session) args.push(session);

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
  wa() {
    console.log("Note: WhatsApp is now managed by the omni process.");
    console.log("Use 'ravi daemon start' to start all services including WhatsApp.");
  }
}

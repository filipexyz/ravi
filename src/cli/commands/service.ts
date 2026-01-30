/**
 * Service Commands - Bot service management CLI
 */

import "reflect-metadata";
import { spawn } from "node:child_process";
import { Group, Command, Arg } from "../decorators.js";

@Group({
  name: "service",
  description: "Bot service management",
})
export class ServiceCommands {
  @Command({ name: "start", description: "Start the bot server" })
  start() {
    console.log("Starting Ravi bot server...");
    const child = spawn("tsx", ["src/index.ts"], {
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
    const child = spawn("tsx", args, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", (err) => {
      console.error(`Failed to start TUI: ${err.message}`);
      process.exit(1);
    });
  }

  @Command({ name: "wa", description: "Start WhatsApp gateway" })
  wa() {
    console.log("Starting WhatsApp gateway...");
    const child = spawn("tsx", ["src/wa.ts"], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("error", (err) => {
      console.error(`Failed to start gateway: ${err.message}`);
      process.exit(1);
    });
  }
}

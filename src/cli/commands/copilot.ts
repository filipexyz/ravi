/**
 * Copilot Commands - Bridge Ravi to Claude Code team mailboxes
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { nats } from "../../nats.js";

/** Base path for Claude Code teams */
function teamsDir(): string {
  return join(homedir(), ".claude", "teams");
}

/** Path to a team's inbox file */
function inboxPath(teamName: string): string {
  return join(teamsDir(), teamName, "inboxes", "team-lead.json");
}

/** Path to a team's config file */
function configPath(teamName: string): string {
  return join(teamsDir(), teamName, "config.json");
}

interface InboxMessage {
  from: string;
  text: string;
  read: boolean;
  timestamp: string;
  summary?: string;
  color?: string;
}

interface TeamConfig {
  name?: string;
  members?: Array<{ name?: string; role?: string }>;
  [key: string]: unknown;
}

@Group({
  name: "copilot",
  description: "Claude Code copilot bridge",
  scope: "open",
})
export class CopilotCommands {
  @Command({ name: "send", description: "Send a message to a Claude Code team inbox" })
  async send(
    @Arg("teamName", { description: "Team name (matches ~/.claude/teams/<name>)" }) teamName: string,
    @Arg("message", { description: "Message text to send" }) message: string,
    @Option({ flags: "--from <name>", description: "Sender name (default: ravi)" }) from?: string,
    @Option({ flags: "--summary <text>", description: "Short summary shown as title" }) summary?: string,
    @Option({ flags: "--color <color>", description: "Message color (e.g. blue, red, green)" }) color?: string,
  ) {
    const inbox = inboxPath(teamName);
    const inboxDir = join(teamsDir(), teamName, "inboxes");

    // Ensure inbox directory exists
    if (!existsSync(inboxDir)) {
      mkdirSync(inboxDir, { recursive: true });
    }

    // Read existing messages (or start with empty array)
    let messages: InboxMessage[] = [];
    if (existsSync(inbox)) {
      try {
        const raw = readFileSync(inbox, "utf-8");
        messages = JSON.parse(raw);
        if (!Array.isArray(messages)) {
          messages = [];
        }
      } catch {
        // Corrupted file, start fresh
        messages = [];
      }
    }

    // Append new message
    const entry: InboxMessage = {
      from: from ?? "ravi",
      text: message,
      read: false,
      timestamp: new Date().toISOString(),
      ...(summary && { summary }),
      ...(color && { color }),
    };
    messages.push(entry);

    // Atomic write: write to temp file then rename
    const tmpPath = inbox + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(messages, null, 2) + "\n", "utf-8");
    renameSync(tmpPath, inbox);

    // Register inbox watch so the daemon polls for replies addressed to sender
    const agentId = entry.from;
    try {
      await nats.emit("ravi.copilot.watch", { team: teamName, agentId });
    } catch {
      // Non-fatal: watch will just not be registered if daemon is down
    }

    console.log(`Message sent to team "${teamName}" inbox`);
    console.log(`  From: ${entry.from}`);
    console.log(`  Text: ${entry.text}`);
    console.log(`  File: ${inbox}`);
  }

  @Command({ name: "teams", description: "List discovered Claude Code teams" })
  teams() {
    const base = teamsDir();

    if (!existsSync(base)) {
      console.log("No teams directory found at ~/.claude/teams/");
      console.log("Create a team in Claude Code first.");
      return;
    }

    let entries: string[];
    try {
      entries = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      fail("Could not read teams directory");
      return;
    }

    if (entries.length === 0) {
      console.log("No teams found in ~/.claude/teams/");
      return;
    }

    console.log("\nClaude Code Teams:\n");
    console.log("  TEAM                    MEMBERS                         INBOX");
    console.log("  ----------------------  ------------------------------  -----");

    for (const name of entries) {
      const cfgFile = configPath(name);
      const inboxFile = inboxPath(name);

      // Read config for member names
      let memberNames = "-";
      if (existsSync(cfgFile)) {
        try {
          const cfg: TeamConfig = JSON.parse(readFileSync(cfgFile, "utf-8"));
          if (cfg.members && Array.isArray(cfg.members) && cfg.members.length > 0) {
            memberNames = cfg.members.map((m) => m.name ?? m.role ?? "?").join(", ");
          }
        } catch {
          // skip
        }
      }

      // Check if inbox exists and has messages
      let inboxStatus = "-";
      if (existsSync(inboxFile)) {
        try {
          const msgs: InboxMessage[] = JSON.parse(readFileSync(inboxFile, "utf-8"));
          const unread = msgs.filter((m) => !m.read).length;
          inboxStatus = unread > 0 ? `${unread} unread` : `${msgs.length} msgs`;
        } catch {
          inboxStatus = "?";
        }
      }

      const teamCol = name.padEnd(22);
      const membersCol = memberNames.slice(0, 30).padEnd(30);
      console.log(`  ${teamCol}  ${membersCol}  ${inboxStatus}`);
    }

    console.log(`\n  Total: ${entries.length} team(s)`);
  }
}

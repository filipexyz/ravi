/**
 * Events Command - live stream of all NATS events
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { nats } from "../../nats.js";

// ANSI helpers
const c = {
  reset:   "\x1b[0m",
  dim:     "\x1b[2m",
  bold:    "\x1b[1m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
  bgRed:   "\x1b[41m",
};

function topicColor(topic: string): string {
  if (topic.includes(".prompt"))    return c.cyan;
  if (topic.includes(".response"))  return c.green;
  if (topic.includes(".tool"))      return c.yellow;
  if (topic.includes(".claude"))    return c.blue;
  if (topic.includes("audit"))      return c.red;
  if (topic.includes("contacts"))   return c.magenta;
  if (topic.includes(".cli."))      return c.white;
  if (topic.includes("inbound"))    return c.green;
  if (topic.includes("outbound"))   return c.cyan;
  if (topic.includes("heartbeat") || topic.includes("_heartbeat")) return c.gray;
  if (topic.includes("cron"))       return c.magenta;
  if (topic.includes("trigger"))    return c.yellow;
  if (topic.includes("approval"))   return c.red;
  if (topic.includes("reaction"))   return c.yellow;
  return c.gray;
}

function topicIcon(topic: string): string {
  if (topic.includes(".prompt"))    return "→";
  if (topic.includes(".response"))  return "←";
  if (topic.includes(".tool"))      return "⚙";
  if (topic.includes(".claude"))    return "◆";
  if (topic.includes("audit"))      return "⛔";
  if (topic.includes("contacts"))   return "👤";
  if (topic.includes("inbound"))    return "↓";
  if (topic.includes("outbound"))   return "↑";
  if (topic.includes("heartbeat"))  return "♡";
  if (topic.includes("cron"))       return "⏰";
  if (topic.includes("trigger"))    return "⚡";
  if (topic.includes("approval"))   return "?";
  return "·";
}

function formatTimestamp(): string {
  const now = new Date();
  const h  = String(now.getHours()).padStart(2, "0");
  const m  = String(now.getMinutes()).padStart(2, "0");
  const s  = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function formatData(data: Record<string, unknown>, topic: string): string {
  // For prompt/response, pull out the text and show it prominently
  if (topic.includes(".prompt") && typeof data.prompt === "string") {
    const prompt = truncate(data.prompt as string, 120);
    const source = data.source
      ? ` ${c.dim}[${(data.source as Record<string, unknown>).channel ?? "?"}]${c.reset}`
      : "";
    return `${c.bold}${prompt}${c.reset}${source}`;
  }

  if (topic.includes(".response") && typeof data.response === "string") {
    const response = truncate(data.response as string, 120);
    const target = data.target
      ? ` ${c.dim}[→ ${(data.target as Record<string, unknown>).chatId ?? "?"}]${c.reset}`
      : "";
    return `${c.bold}${response}${c.reset}${target}`;
  }

  // For tool events, show name + event type + input/output summary
  if (topic.includes(".tool") && data.toolName) {
    const event  = data.event ?? data.type ?? "?";
    const name   = data.toolName as string;
    const dur    = data.durationMs ? ` ${c.dim}${data.durationMs}ms${c.reset}` : "";
    const err    = data.isError ? ` ${c.red}ERROR${c.reset}` : "";
    let detail   = "";

    if (event === "start" && data.input) {
      const input = data.input as Record<string, unknown>;
      if (name === "Bash" && input.command) {
        detail = ` ${c.dim}$ ${truncate(String(input.command), 80)}${c.reset}`;
      } else if (input.file_path) {
        detail = ` ${c.dim}${truncate(String(input.file_path), 60)}${c.reset}`;
      } else if (input.pattern) {
        detail = ` ${c.dim}${truncate(String(input.pattern), 60)}${c.reset}`;
      }
    }

    return `${c.bold}${name}${c.reset} ${c.dim}${event}${c.reset}${dur}${err}${detail}`;
  }

  // For claude SDK events, show type
  if (topic.includes(".claude") && data.type) {
    const type = data.type as string;
    if (type === "result") {
      const usage = (data as Record<string, unknown>).usage as Record<string, number> | undefined;
      const tokens = usage ? ` ${c.dim}in=${usage.input_tokens} out=${usage.output_tokens}${c.reset}` : "";
      return `${c.bold}result${c.reset}${tokens}`;
    }
    if (type === "silent") {
      return `${c.magenta}${c.bold}SILENT${c.reset}`;
    }
    return `${c.dim}${type}${c.reset}`;
  }

  // For CLI events, show tool + truncated output
  if (topic.includes(".cli.") && data.tool) {
    const output = data.output ? truncate(String(data.output), 80) : "";
    const err    = data.isError ? ` ${c.red}[error]${c.reset}` : "";
    return `${c.bold}${data.tool}${c.reset}${err}${output ? `  ${c.dim}${output}${c.reset}` : ""}`;
  }

  // Default: compact JSON, truncated
  const json = JSON.stringify(data);
  return `${c.dim}${truncate(json, 160)}${c.reset}`;
}

function formatTopic(topic: string): string {
  // Session events: ravi.session.agent:main:dm:5511999.prompt → [dm:5511999] prompt
  const sessionMatch = topic.match(/ravi\.session\.(agent:[^.]+):(.+)\.(\w+)$/);
  if (sessionMatch) {
    const sessionKey = sessionMatch[2]; // dm:5511999 or dev-ravi-dev
    const eventType = sessionMatch[3];  // prompt, response, tool, claude
    return `[${sessionKey}] ${eventType}`;
  }

  // CLI events: ravi._cli.cli.daemon.restart → cli daemon.restart
  if (topic.startsWith("ravi._cli.cli.")) {
    return `cli ${topic.slice("ravi._cli.cli.".length)}`;
  }

  // Internal events: ravi.inbound.reaction → inbound.reaction
  if (topic.startsWith("ravi.")) {
    return topic.slice("ravi.".length);
  }

  // Omni JetStream: message.received.whatsapp-baileys.UUID → msg.received
  const omniMatch = topic.match(/^(message|reaction|instance)\.(\w[\w-]*)\.whatsapp/);
  if (omniMatch) {
    return `${omniMatch[1]}.${omniMatch[2]}`;
  }

  return topic;
}

function matches(topic: string, filter: string): boolean {
  // Simple glob: * matches anything within a segment, ** matches across segments
  const regex = new RegExp(
    "^" +
    filter
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^.]*") +
    "$"
  );
  return regex.test(topic);
}

@Group({
  name: "events",
  description: "Stream live NATS events",
  scope: "open",
})
export class EventsCommands {
  @Command({ name: "stream", description: "Stream all events in real-time (default command)" })
  async stream(
    @Option({ flags: "-f, --filter <pattern>", description: "Topic glob filter (e.g. 'ravi.session.*')" }) filter?: string,
    @Option({ flags: "--no-claude", description: "Hide raw claude SDK events (type=text, type=thinking, etc.)" }) noClaude?: boolean,
    @Option({ flags: "--no-heartbeat", description: "Hide heartbeat events" }) noHeartbeat?: boolean,
    @Option({ flags: "--only <type>", description: "Only show: prompt, response, tool, claude, cli, audit" }) only?: string,
  ) {
    const topicPattern = ">";  // NATS wildcard for all topics

    console.log(`\n${c.bold}NATS Event Stream${c.reset}`);
    if (filter)       console.log(`  filter:   ${c.cyan}${filter}${c.reset}`);
    if (only)         console.log(`  only:     ${c.cyan}${only}${c.reset}`);
    if (noClaude)     console.log(`  hiding:   claude SDK events`);
    if (noHeartbeat)  console.log(`  hiding:   heartbeat events`);
    console.log(`  topic:    ${c.gray}>${c.reset}  (all)`);
    console.log(`\n${c.dim}Ctrl+C to exit${c.reset}\n`);
    console.log(`${c.dim}${"─".repeat(80)}${c.reset}`);

    let count = 0;

    for await (const event of nats.subscribe(topicPattern)) {
      const { topic, data } = event;

      // Apply --filter
      if (filter && !matches(topic, filter)) continue;

      // Apply --only
      if (only) {
        const t = only.toLowerCase();
        if (t === "prompt"   && !topic.includes(".prompt"))   continue;
        if (t === "response" && !topic.includes(".response")) continue;
        if (t === "tool"     && !topic.includes(".tool"))     continue;
        if (t === "claude"   && !topic.includes(".claude"))   continue;
        if (t === "cli"      && !topic.includes(".cli."))     continue;
        if (t === "audit"    && !topic.includes("audit"))     continue;
      }

      // Apply --no-claude: skip noisy streaming text events
      if (noClaude && topic.includes(".claude")) {
        const type = (data as Record<string, unknown>).type as string | undefined;
        if (type && type !== "result" && type !== "system") continue;
      }

      // Apply --no-heartbeat
      if (noHeartbeat && (
        topic.includes("heartbeat") ||
        (data as Record<string, unknown>)._heartbeat === true
      )) continue;

      // Always hide noisy events (omni JetStream, streaming chunks, stream_event)
      if (
        topic.includes("presence.typing") ||
        topic.includes("chat.unread-updated") ||
        topic.includes(".stream") ||
        topic.startsWith("message.") ||
        topic.startsWith("reaction.") ||
        topic.startsWith("instance.")
      ) continue;

      // Hide stream_event from claude events
      if (topic.includes(".claude") && (data as Record<string, unknown>).type === "stream_event") continue;

      count++;
      const ts    = formatTimestamp();
      const col   = topicColor(topic);
      const icon  = topicIcon(topic);
      const short = formatTopic(topic);
      const body  = formatData(data as Record<string, unknown>, topic);

      process.stdout.write(
        `${c.dim}${ts}${c.reset} ${col}${icon}${c.reset} ${col}${short}${c.reset}  ${body}\n`
      );
    }

    console.log(`\n${c.dim}${count} events received${c.reset}`);
  }
}

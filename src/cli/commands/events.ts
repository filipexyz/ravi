/**
 * Events Command - live stream of all NATS events
 */

import "reflect-metadata";
import { Group, Command, CliOnly, Option } from "../decorators.js";
import { DeliverPolicy, StringCodec } from "nats";
import { ensureConnected, nats } from "../../nats.js";
import { resolveSession } from "../../router/sessions.js";

const sc = StringCodec();
const DEFAULT_REPLAY_LOOKBACK_MS = 15 * 60_000;
const DEFAULT_REPLAY_LIMIT = 100;
const DEFAULT_REPLAY_SCAN_MULTIPLIER = 10;
const MAX_REPLAY_SCAN_PER_STREAM = 10_000;

// ANSI helpers
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgRed: "\x1b[41m",
};

function topicColor(topic: string): string {
  if (topic.includes(".prompt")) return c.cyan;
  if (topic.includes(".response")) return c.green;
  if (topic.includes(".tool")) return c.yellow;
  if (topic.includes(".claude")) return c.blue;
  if (topic.includes(".runtime")) return c.blue;
  if (topic.includes("audit")) return c.red;
  if (topic.includes("contacts")) return c.magenta;
  if (topic.includes(".cli.")) return c.white;
  if (topic.includes("inbound")) return c.green;
  if (topic.includes("outbound")) return c.cyan;
  if (topic.includes("heartbeat") || topic.includes("_heartbeat")) return c.gray;
  if (topic.includes("cron")) return c.magenta;
  if (topic.includes("trigger")) return c.yellow;
  if (topic.includes("approval")) return c.red;
  if (topic.includes("reaction")) return c.yellow;
  return c.gray;
}

function topicIcon(topic: string): string {
  if (topic.includes(".prompt")) return "→";
  if (topic.includes(".response")) return "←";
  if (topic.includes(".tool")) return "⚙";
  if (topic.includes(".claude")) return "◆";
  if (topic.includes(".runtime")) return "◆";
  if (topic.includes("audit")) return "⛔";
  if (topic.includes("contacts")) return "👤";
  if (topic.includes("inbound")) return "↓";
  if (topic.includes("outbound")) return "↑";
  if (topic.includes("heartbeat")) return "♡";
  if (topic.includes("cron")) return "⏰";
  if (topic.includes("trigger")) return "⚡";
  if (topic.includes("approval")) return "?";
  return "·";
}

function formatTimestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function shortId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function formatDimParts(parts: (string | undefined)[]): string {
  const compact = parts.filter((part): part is string => Boolean(part));
  return compact.length > 0 ? ` ${c.dim}${compact.join(" ")}${c.reset}` : "";
}

export function formatData(data: Record<string, unknown>, topic: string): string {
  if (topic.startsWith("message.received.")) {
    const payload = data.payload as Record<string, unknown> | undefined;
    const content = payload?.content as Record<string, unknown> | undefined;
    const contentType = typeof content?.type === "string" ? content.type : "message";
    const text = typeof content?.text === "string" ? ` "${truncate(content.text, 100)}"` : "";
    const chatId = typeof payload?.chatId === "string" ? ` chat=${payload.chatId}` : "";
    const from = typeof payload?.from === "string" ? ` from=${payload.from}` : "";
    return `${c.bold}message.received${c.reset} ${contentType}${text}${c.dim}${chatId}${from}${c.reset}`;
  }

  // For prompt/response, pull out the text and show it prominently
  if (topic.includes(".prompt") && typeof data.prompt === "string") {
    const prompt = truncate(data.prompt as string, 120);
    const source = data.source ? ` ${c.dim}[${(data.source as Record<string, unknown>).channel ?? "?"}]${c.reset}` : "";
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
    const event = data.event ?? data.type ?? "?";
    const name = data.toolName as string;
    const dur = data.durationMs ? ` ${c.dim}${data.durationMs}ms${c.reset}` : "";
    const err = data.isError ? ` ${c.red}ERROR${c.reset}` : "";
    let detail = "";

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
    if (type === "system" && (data as any).subtype === "init" && (data as any).model) {
      return `${c.dim}system${c.reset} ${c.dim}${(data as any).model}${c.reset}`;
    }
    return `${c.dim}${type}${c.reset}`;
  }

  // For provider runtime events, show normalized type
  if (topic.includes(".runtime") && data.type) {
    const type = data.type as string;
    if (type === "provider.raw") {
      const metadata = asRecord(data.metadata);
      const rawEvent = asRecord(data.rawEvent);
      const thread = asRecord(data.thread) ?? asRecord(metadata?.thread) ?? asRecord(rawEvent?.thread);
      const turn = asRecord(data.turn) ?? asRecord(metadata?.turn) ?? asRecord(rawEvent?.turn);
      const item = asRecord(data.item) ?? asRecord(metadata?.item) ?? asRecord(rawEvent?.item);
      const nativeEvent = firstString(data.nativeEvent, metadata?.nativeEvent, rawEvent?.type) ?? "provider.raw";
      const model = firstString(data.model, rawEvent?.model, rawEvent?.modelId, rawEvent?.model_id);
      const modelProvider = firstString(data.modelProvider, rawEvent?.modelProvider, rawEvent?.model_provider);
      const threadId = shortId(firstString(data.threadId, thread?.id, rawEvent?.thread_id, rawEvent?.threadId));
      const turnId = shortId(firstString(data.turnId, turn?.id, rawEvent?.turn_id, rawEvent?.turnId));
      const itemId = shortId(firstString(data.itemId, item?.id, rawEvent?.item_id, rawEvent?.itemId));
      const detail = formatDimParts([
        model ? `model=${model}` : undefined,
        modelProvider ? `provider=${modelProvider}` : undefined,
        threadId ? `thread=${threadId}` : undefined,
        turnId ? `turn=${turnId}` : undefined,
        itemId ? `item=${itemId}` : undefined,
      ]);
      return `${c.bold}${nativeEvent}${c.reset}${detail}`;
    }
    if (type === "turn.complete") {
      const usage = (data as Record<string, unknown>).usage as Record<string, number> | undefined;
      const tokens = usage ? ` ${c.dim}in=${usage.inputTokens} out=${usage.outputTokens}${c.reset}` : "";
      const execution = asRecord(data.execution);
      const rawEvent = asRecord(data.rawEvent);
      const model = firstString(execution?.model, data.model, rawEvent?.model);
      const modelProvider = firstString(
        execution?.provider,
        data.modelProvider,
        rawEvent?.modelProvider,
        rawEvent?.model_provider,
      );
      const runtime = formatDimParts([
        model ? `model=${model}` : undefined,
        modelProvider ? `provider=${modelProvider}` : undefined,
      ]);
      return `${c.bold}turn.complete${c.reset}${runtime}${tokens}`;
    }
    if (type === "turn.failed" || type === "turn.interrupted") {
      const error =
        typeof data.error === "string"
          ? data.error
          : data.error &&
              typeof data.error === "object" &&
              typeof (data.error as { message?: unknown }).message === "string"
            ? ((data.error as { message?: string }).message ?? "")
            : "";
      const detail = error ? ` ${c.red}${truncate(error, 120)}${c.reset}` : "";
      return `${c.bold}${type}${c.reset}${detail}`;
    }
    if (type === "silent") {
      return `${c.magenta}${c.bold}SILENT${c.reset}`;
    }
    return `${c.dim}${type}${c.reset}`;
  }

  // For CLI events, show tool + truncated output
  if (topic.includes(".cli.") && data.tool) {
    const output = data.output ? truncate(String(data.output), 80) : "";
    const err = data.isError ? ` ${c.red}[error]${c.reset}` : "";
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
    const eventType = sessionMatch[3]; // prompt, response, tool, claude
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
      "$",
  );
  return regex.test(topic);
}

function matchesNatsSubject(subject: string, pattern: string): boolean {
  const subjectParts = subject.split(".");
  const patternParts = pattern.split(".");
  for (let index = 0; index < patternParts.length; index++) {
    const patternPart = patternParts[index];
    if (patternPart === ">") return true;
    const subjectPart = subjectParts[index];
    if (subjectPart === undefined) return false;
    if (patternPart !== "*" && patternPart !== subjectPart) return false;
  }
  return subjectParts.length === patternParts.length;
}

function parseDuration(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount)) return null;
  if (unit === "ms") return amount;
  if (unit === "s" || unit === "sec") return amount * 1_000;
  if (unit === "m" || unit === "min") return amount * 60_000;
  if (unit === "h" || unit === "hr") return amount * 3_600_000;
  if (unit === "d") return amount * 86_400_000;
  return null;
}

export function parseReplayTime(value: string | undefined, fallbackLookbackMs?: number): Date {
  if (!value?.trim()) {
    return new Date(Date.now() - (fallbackLookbackMs ?? DEFAULT_REPLAY_LOOKBACK_MS));
  }
  const trimmed = value.trim();
  const duration = parseDuration(trimmed);
  if (duration !== null) {
    return new Date(Date.now() - duration);
  }
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    return new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid time value: ${value}. Use ISO, epoch, or duration like 15m/2h/1d.`);
  }
  return new Date(parsed);
}

function splitList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!segment) return undefined;
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

type ReplayWhereFilter = {
  path: string;
  op: "=" | "!=" | "~=";
  expected: string;
};

type ResolvedReplaySessionFilter = {
  input: string;
  needles: string[];
  sessionName?: string;
  sessionKey?: string;
  chatId?: string;
};

function parseWhereFilters(value?: string): ReplayWhereFilter[] {
  return splitList(value?.replace(/;/g, ",")).map((expr) => {
    const op = expr.includes("~=") ? "~=" : expr.includes("!=") ? "!=" : "=";
    const [path, ...rest] = expr.split(op);
    const normalizedPath = path?.trim();
    const expected = rest
      .join(op)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!normalizedPath || !expected) {
      throw new Error(`Invalid --where expression: ${expr}. Use path=value, path!=value or path~=text.`);
    }
    return { path: normalizedPath, op, expected };
  });
}

function resolveReplaySessionFilter(value?: string): ResolvedReplaySessionFilter | undefined {
  const input = value?.trim();
  if (!input) return undefined;

  const needles = new Set<string>([input]);
  const session = resolveSession(input);
  if (session) {
    needles.add(session.sessionKey);
    if (session.name) needles.add(session.name);
    if (session.lastTo) needles.add(session.lastTo);
    if (session.lastThreadId) needles.add(session.lastThreadId);
    if (session.groupId) needles.add(session.groupId);
    if (session.accountId) needles.add(session.accountId);
    if (session.lastAccountId) needles.add(session.lastAccountId);
  }

  return {
    input,
    needles: [...needles].filter(Boolean),
    sessionName: session?.name,
    sessionKey: session?.sessionKey,
    chatId: session?.lastTo,
  };
}

export function matchesReplayFilters(
  event: { subject: string; data: Record<string, unknown>; raw: string },
  filters: {
    subject?: string;
    contains?: string[];
    where?: ReplayWhereFilter[];
    type?: string;
    session?: string | ResolvedReplaySessionFilter;
    chat?: string;
    agent?: string;
  },
): boolean {
  if (filters.subject && !matchesNatsSubject(event.subject, filters.subject)) {
    return false;
  }

  const contains = filters.contains ?? [];
  for (const needle of contains) {
    if (
      !event.raw.toLowerCase().includes(needle.toLowerCase()) &&
      !event.subject.toLowerCase().includes(needle.toLowerCase())
    ) {
      return false;
    }
  }

  const sessionNeedles = typeof filters.session === "string" ? [filters.session] : filters.session?.needles;

  if (sessionNeedles?.length) {
    const matchesSession = sessionNeedles.some(
      (needle) => event.raw.includes(needle) || event.subject.includes(needle),
    );
    if (!matchesSession) return false;
  }

  for (const needle of [filters.chat, filters.agent].filter(Boolean) as string[]) {
    if (!event.raw.includes(needle) && !event.subject.includes(needle)) {
      return false;
    }
  }

  if (filters.type) {
    const type = getPathValue(event.data, "type");
    const payloadType = getPathValue(event.data, "payload.type");
    if (String(type ?? payloadType ?? "") !== filters.type) {
      return false;
    }
  }

  for (const filter of filters.where ?? []) {
    const actual = getPathValue(event.data, filter.path);
    const actualText = typeof actual === "string" ? actual : actual === undefined ? "" : JSON.stringify(actual);
    if (filter.op === "=" && actualText !== filter.expected) return false;
    if (filter.op === "!=" && actualText === filter.expected) return false;
    if (filter.op === "~=" && !actualText.includes(filter.expected)) return false;
  }

  return true;
}

function formatReplayTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

type ReplayEvent = {
  stream: string;
  seq: number;
  subject: string;
  timestampMs: number;
  data: Record<string, unknown>;
  raw: string;
};

type LiveEventJsonRecord = {
  type: "event";
  count: number;
  topic: string;
  shortTopic: string;
  timestamp: string;
  data: Record<string, unknown>;
};

export function formatLiveEventJsonRecord(input: {
  count: number;
  topic: string;
  data: Record<string, unknown>;
  now?: Date;
}): LiveEventJsonRecord {
  return {
    type: "event",
    count: input.count,
    topic: input.topic,
    shortTopic: formatTopic(input.topic),
    timestamp: (input.now ?? new Date()).toISOString(),
    data: input.data,
  };
}

function formatReplayLine(event: ReplayEvent): string {
  const ts = formatReplayTimestamp(event.timestampMs);
  const col = topicColor(event.subject);
  const icon = topicIcon(event.subject);
  const short = formatTopic(event.subject);
  const body = formatData(event.data, event.subject);
  return `${c.dim}${ts}${c.reset} ${col}${icon}${c.reset} ${c.gray}${event.stream}#${event.seq}${c.reset} ${col}${short}${c.reset}  ${body}`;
}

async function listJetStreamNames(): Promise<string[]> {
  const nc = await ensureConnected();
  const jsm = await nc.jetstreamManager();
  const names: string[] = [];
  const lister = jsm.streams.list();
  while (true) {
    const page = await lister.next();
    if (!page?.length) break;
    for (const stream of page) {
      if (stream.config.name?.startsWith("KV_")) continue;
      names.push(stream.config.name);
    }
  }
  return names.sort();
}

async function replayStream(options: {
  stream: string;
  subject?: string;
  since: Date;
  scan: number;
}): Promise<ReplayEvent[]> {
  const nc = await ensureConnected();
  const js = nc.jetstream();
  const consumer = await js.consumers.get(options.stream, {
    ...(options.subject ? { filterSubjects: options.subject } : {}),
    deliver_policy: DeliverPolicy.StartTime,
    opt_start_time: options.since.toISOString(),
    inactive_threshold: 30_000_000_000,
  });
  const messages = await consumer.fetch({ max_messages: options.scan, expires: 1500 });
  const events: ReplayEvent[] = [];

  for await (const msg of messages) {
    let raw: string;
    try {
      raw = sc.decode(msg.data);
    } catch {
      raw = "";
    }

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      data = { raw };
    }

    events.push({
      stream: options.stream,
      seq: msg.info.streamSequence,
      subject: msg.subject,
      timestampMs: Math.floor(msg.info.timestampNanos / 1_000_000),
      data,
      raw,
    });
  }

  return events;
}

@Group({
  name: "events",
  description: "Stream live NATS events",
  scope: "open",
})
export class EventsCommands {
  @Command({ name: "stream", description: "Stream all events in real-time (default command)" })
  @CliOnly()
  async stream(
    @Option({ flags: "-f, --filter <pattern>", description: "Topic glob filter (e.g. 'ravi.session.*')" })
    filter?: string,
    @Option({ flags: "--no-claude", description: "Hide raw claude SDK events (type=text, type=thinking, etc.)" })
    noClaude?: boolean,
    @Option({ flags: "--no-heartbeat", description: "Hide heartbeat events" }) noHeartbeat?: boolean,
    @Option({ flags: "--only <type>", description: "Only show: prompt, response, tool, claude, runtime, cli, audit" })
    only?: string,
    @Option({ flags: "--json", description: "Print raw events as JSONL" }) asJson?: boolean,
  ) {
    const topicPattern = ">"; // NATS wildcard for all topics

    if (!asJson) {
      console.log(`\n${c.bold}NATS Event Stream${c.reset}`);
      if (filter) console.log(`  filter:   ${c.cyan}${filter}${c.reset}`);
      if (only) console.log(`  only:     ${c.cyan}${only}${c.reset}`);
      if (noClaude) console.log(`  hiding:   claude SDK events`);
      if (noHeartbeat) console.log(`  hiding:   heartbeat events`);
      console.log(`  topic:    ${c.gray}>${c.reset}  (all)`);
      console.log(`\n${c.dim}Ctrl+C to exit${c.reset}\n`);
      console.log(`${c.dim}${"─".repeat(80)}${c.reset}`);
    }

    let count = 0;

    for await (const event of nats.subscribe(topicPattern)) {
      const { topic, data } = event;

      // Apply --filter
      if (filter && !matches(topic, filter)) continue;

      // Apply --only
      if (only) {
        const t = only.toLowerCase();
        if (t === "prompt" && !topic.includes(".prompt")) continue;
        if (t === "response" && !topic.includes(".response")) continue;
        if (t === "tool" && !topic.includes(".tool")) continue;
        if (t === "claude" && !topic.includes(".claude")) continue;
        if (t === "runtime" && !topic.includes(".runtime")) continue;
        if (t === "cli" && !topic.includes(".cli.")) continue;
        if (t === "audit" && !topic.includes("audit")) continue;
      }

      // Apply --no-claude: skip noisy streaming text events
      if (noClaude && topic.includes(".claude")) {
        const type = (data as Record<string, unknown>).type as string | undefined;
        if (type && type !== "result" && type !== "system") continue;
      }

      // Apply --no-heartbeat
      if (noHeartbeat && (topic.includes("heartbeat") || (data as Record<string, unknown>)._heartbeat === true))
        continue;

      // Always hide noisy events (omni JetStream, streaming chunks, stream_event)
      if (
        topic.includes("presence.typing") ||
        topic.includes("chat.unread-updated") ||
        topic.includes(".stream") ||
        topic.startsWith("message.") ||
        topic.startsWith("reaction.") ||
        topic.startsWith("instance.")
      )
        continue;

      // Hide stream_event from claude events
      if (topic.includes(".claude") && (data as Record<string, unknown>).type === "stream_event") continue;

      count++;
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify(formatLiveEventJsonRecord({ count, topic, data: data as Record<string, unknown> }))}\n`,
        );
        continue;
      }

      const ts = formatTimestamp();
      const col = topicColor(topic);
      const icon = topicIcon(topic);
      const short = formatTopic(topic);
      const body = formatData(data as Record<string, unknown>, topic);
      process.stdout.write(`${c.dim}${ts}${c.reset} ${col}${icon}${c.reset} ${col}${short}${c.reset}  ${body}\n`);
    }

    if (asJson) {
      process.stdout.write(`${JSON.stringify({ type: "stream.end", count, timestamp: new Date().toISOString() })}\n`);
    } else {
      console.log(`\n${c.dim}${count} events received${c.reset}`);
    }
  }

  @Command({ name: "replay", description: "Replay persisted JetStream events with filters" })
  async replay(
    @Option({ flags: "-s, --stream <names>", description: "Comma-separated streams (default: all non-KV streams)" })
    streamOpt?: string,
    @Option({ flags: "--subject <pattern>", description: "NATS subject filter, e.g. message.received.>" })
    subject?: string,
    @Option({ flags: "--since <time>", description: "Start time: ISO, epoch, or duration like 15m/2h (default: 15m)" })
    sinceOpt?: string,
    @Option({ flags: "--until <time>", description: "End time: ISO, epoch, or duration like 5m" })
    untilOpt?: string,
    @Option({ flags: "-n, --limit <count>", description: "Max matching events to print (default: 100)" })
    limitOpt?: string,
    @Option({ flags: "--scan <count>", description: "Max stored events to scan per stream before filters" })
    scanOpt?: string,
    @Option({ flags: "--contains <text>", description: "Case-insensitive substring filter; comma-separated" })
    containsOpt?: string,
    @Option({
      flags: "--where <expr>",
      description: "JSON filter: path=value, path!=value or path~=text; comma/semicolon-separated",
    })
    whereOpt?: string,
    @Option({ flags: "--type <type>", description: "Match data.type or data.payload.type" })
    typeOpt?: string,
    @Option({ flags: "--session <nameOrKey>", description: "Substring filter for a session name/key" })
    sessionOpt?: string,
    @Option({ flags: "--chat <chatId>", description: "Substring filter for channel chatId/groupId" })
    chatOpt?: string,
    @Option({ flags: "--agent <agentId>", description: "Substring filter for agent id" })
    agentOpt?: string,
    @Option({ flags: "--json", description: "Print JSONL" }) asJson?: boolean,
    @Option({ flags: "--raw", description: "Print raw stored payload text" }) rawOutput?: boolean,
  ) {
    const since = parseReplayTime(sinceOpt, DEFAULT_REPLAY_LOOKBACK_MS);
    const until = untilOpt ? parseReplayTime(untilOpt, 0) : undefined;
    const limitParsed = Number.parseInt(limitOpt ?? "", 10);
    const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? Math.min(limitParsed, 5000) : DEFAULT_REPLAY_LIMIT;
    const scanParsed = Number.parseInt(scanOpt ?? "", 10);
    const scan =
      Number.isFinite(scanParsed) && scanParsed > 0
        ? Math.min(scanParsed, MAX_REPLAY_SCAN_PER_STREAM)
        : Math.min(Math.max(limit * DEFAULT_REPLAY_SCAN_MULTIPLIER, 250), MAX_REPLAY_SCAN_PER_STREAM);
    const streams = splitList(streamOpt);
    const streamNames = streams.length > 0 ? streams : await listJetStreamNames();
    const where = parseWhereFilters(whereOpt);
    const contains = splitList(containsOpt);
    const resolvedSession = resolveReplaySessionFilter(sessionOpt);

    if (!asJson) {
      console.log(`\n${c.bold}NATS Replay${c.reset}`);
      console.log(`  streams:  ${c.cyan}${streamNames.join(", ")}${c.reset}`);
      console.log(`  since:    ${c.cyan}${since.toISOString()}${c.reset}`);
      if (until) console.log(`  until:    ${c.cyan}${until.toISOString()}${c.reset}`);
      if (subject) console.log(`  subject:  ${c.cyan}${subject}${c.reset}`);
      if (resolvedSession) {
        const resolved = [
          resolvedSession.sessionName && `name=${resolvedSession.sessionName}`,
          resolvedSession.chatId && `chat=${resolvedSession.chatId}`,
        ]
          .filter(Boolean)
          .join(" ");
        console.log(
          `  session:  ${c.cyan}${resolvedSession.input}${c.reset}${resolved ? ` ${c.dim}(${resolved})${c.reset}` : ""}`,
        );
      }
      if (contains.length > 0) console.log(`  contains: ${c.cyan}${contains.join(", ")}${c.reset}`);
      if (where.length > 0) console.log(`  where:    ${c.cyan}${whereOpt}${c.reset}`);
      console.log(`  scan:     ${c.cyan}${scan}/stream${c.reset}`);
      console.log(`${c.dim}${"─".repeat(80)}${c.reset}`);
    }

    const batches = await Promise.allSettled(
      streamNames.map(async (stream) => replayStream({ stream, subject, since, scan })),
    );
    const events = batches.flatMap((result, index) => {
      if (result.status === "fulfilled") return result.value;
      if (!asJson) {
        console.error(
          `${c.yellow}skip ${streamNames[index]}:${c.reset} ${String(result.reason?.message ?? result.reason)}`,
        );
      }
      return [];
    });

    const filters = {
      subject,
      contains,
      where,
      type: typeOpt,
      session: resolvedSession ?? sessionOpt,
      chat: chatOpt,
      agent: agentOpt,
    };
    const matched = events
      .filter((event) => (!until || event.timestampMs <= until.getTime()) && matchesReplayFilters(event, filters))
      .sort((a, b) => a.timestampMs - b.timestampMs || a.stream.localeCompare(b.stream) || a.seq - b.seq)
      .slice(0, limit);

    for (const event of matched) {
      if (asJson) {
        console.log(
          JSON.stringify({
            stream: event.stream,
            seq: event.seq,
            subject: event.subject,
            timestamp: new Date(event.timestampMs).toISOString(),
            data: event.data,
            ...(rawOutput ? { raw: event.raw } : {}),
          }),
        );
      } else if (rawOutput) {
        console.log(`${formatReplayLine(event)}\n${event.raw}\n`);
      } else {
        console.log(formatReplayLine(event));
      }
    }

    if (!asJson) {
      console.log(`${c.dim}${"─".repeat(80)}${c.reset}`);
      console.log(`${c.dim}${matched.length} matching event${matched.length === 1 ? "" : "s"} printed${c.reset}`);
    }

    await nats.close();
  }
}

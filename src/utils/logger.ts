import { errorDiagnostic, projectFailureDiagnostic, redactDiagnosticText } from "./error-diagnostic.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";
type TerminalStream = "stdout" | "stderr";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ANSI colors for terminal
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  debug: "\x1b[36m", // cyan
  info: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  context: "\x1b[35m", // magenta
};

// Log file path
const LOG_DIR = join(homedir(), ".ravi", "logs");
const LOG_FILE = join(LOG_DIR, "ravi.log");
const TERMINAL_DEFAULT_VALUE_LIMIT = 80;
const TERMINAL_LONG_VALUE_LIMIT = 4096;

/** Context that persists across log calls */
interface LogContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

class Logger {
  private static globalLevel: LogLevel = "info";
  private static fileLogging = false;
  // stdout is reserved for user-facing CLI payloads and machine-readable protocols.
  private static terminalStream: TerminalStream = "stderr";
  private prefix: string;
  private context: LogContext;

  constructor(prefix = "ravi", context: LogContext = {}) {
    this.prefix = prefix;
    this.context = context;
  }

  static setGlobalLevel(level: LogLevel): void {
    Logger.globalLevel = level;
  }

  static setTerminalStream(stream: TerminalStream): void {
    Logger.terminalStream = stream;
  }

  setTerminalStream(stream: TerminalStream): void {
    Logger.terminalStream = stream;
  }

  static enableFileLogging(): void {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      Logger.fileLogging = true;
    } catch {
      console.error("Failed to create log directory");
    }
  }

  setLevel(level: LogLevel): void {
    Logger.globalLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[Logger.globalLevel];
  }

  private normalizeLogData(data?: unknown, seen = new Set<unknown>()): unknown {
    if (data instanceof Error) {
      return { error: errorDiagnostic(data).cause, ...errorDiagnostic(data) };
    }
    if (typeof data === "string") return redactDiagnosticText(data);
    if (!data || typeof data !== "object") return data;
    if (seen.has(data) || seen.size >= 32) return "[redacted:recursive]";
    seen.add(data);
    if (Array.isArray(data)) return data.slice(0, 32).map((value) => this.normalizeLogData(value, seen));
    const source = data as Record<string, unknown>;
    if (
      typeof source.message === "string" &&
      (source.code !== undefined || source.cause !== undefined || source.status !== undefined)
    )
      return projectFailureDiagnostic(source);
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data).slice(0, 64)) {
      if (/^(?:stack|headers|cookies?|body|request|response)$/i.test(key)) continue;
      if (value instanceof Error || key === "error") {
        const diagnostic = errorDiagnostic(value);
        if (key === "error") Object.assign(normalized, { error: diagnostic.cause, ...diagnostic });
        else normalized[key] = diagnostic;
      } else normalized[key] = this.normalizeLogData(value, seen);
    }
    return normalized;
  }

  private formatForTerminal(level: LogLevel, message: string, data?: unknown): string {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8); // HH:MM:SS
    const color = COLORS[level];
    const levelStr = level.toUpperCase().padEnd(5);

    // Build context string from persistent context + data
    const merged = {
      ...(this.normalizeLogData(this.context) as LogContext),
      ...(typeof data === "object" && data ? data : {}),
    };
    const contextParts: string[] = [];

    // Prioritize important fields
    if (merged.sessionKey) {
      contextParts.push(`session=${merged.sessionKey}`);
      delete merged.sessionKey;
    }
    if (merged.agentId) {
      contextParts.push(`agent=${merged.agentId}`);
      delete merged.agentId;
    }

    // Add remaining fields
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== null) {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        const maxLength =
          k === "cause" ||
          k === "error" ||
          k === "context" ||
          k === "stack" ||
          k.endsWith("Stack") ||
          k === "failureDetails" ||
          k === "rawEventErrors" ||
          k === "line" ||
          k === "chunk" ||
          k === "sql"
            ? TERMINAL_LONG_VALUE_LIMIT
            : TERMINAL_DEFAULT_VALUE_LIMIT;
        const truncated = val.length > maxLength ? val.slice(0, maxLength - 3) + "..." : val;
        contextParts.push(`${k}=${truncated}`);
      }
    }

    const contextStr = contextParts.length > 0 ? ` ${COLORS.dim}${contextParts.join(" ")}${COLORS.reset}` : "";

    return `${COLORS.dim}${time}${COLORS.reset} ${color}${levelStr}${COLORS.reset} [${this.prefix}] ${message}${contextStr}`;
  }

  private formatForFile(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const merged = {
      ...(this.normalizeLogData(this.context) as LogContext),
      ...(typeof data === "object" && data ? data : {}),
    };

    const entry = {
      t: timestamp,
      l: level,
      p: this.prefix,
      m: message,
      ...merged,
    };

    return JSON.stringify(entry);
  }

  private writeToFile(line: string): void {
    if (!Logger.fileLogging) return;
    try {
      appendFileSync(LOG_FILE, line + "\n");
    } catch {
      // Silently fail file logging
    }
  }

  private writeToTerminal(line: string): void {
    const stream = Logger.terminalStream === "stdout" ? process.stdout : process.stderr;
    stream.write(`${line}\n`);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    // Error-level metadata is an untrusted exception boundary. Keep only the
    // diagnostic plus explicit logger correlation fields, never arbitrary data.
    let normalizedData = this.normalizeLogData(data);
    if (level === "error" && data && typeof data === "object") {
      const source = data as Record<string, unknown>;
      const diagnostic = errorDiagnostic(source.error ?? source.cause ?? data);
      const projected = projectFailureDiagnostic(source);
      const correlation: Record<string, unknown> = {};
      for (const key of ["sessionKey", "agentId", "requestId", "command"] as const)
        if (typeof source[key] === "string") correlation[key] = redactDiagnosticText(source[key]);
      normalizedData = {
        ...(Number.isInteger(source.suppressed) && Number(source.suppressed) >= 0
          ? { suppressed: source.suppressed }
          : {}),
        ...correlation,
        ...projected,
        ...diagnostic,
        ...(source.context ? { context: projected.context } : {}),
        error: diagnostic.cause,
        failureDetails: diagnostic.cause,
      };
    }
    const terminalLine = this.formatForTerminal(level, redactDiagnosticText(message), normalizedData);
    const fileLine = this.formatForFile(level, redactDiagnosticText(message), normalizedData);

    this.writeToTerminal(terminalLine);
    this.writeToFile(fileLine);
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("error", message, data);
  }

  /**
   * Create a child logger with additional prefix
   */
  child(prefix: string): Logger {
    return new Logger(`${this.prefix}:${prefix}`, { ...this.context });
  }

  /**
   * Create a child logger with persistent context
   * Context fields appear in all subsequent logs
   */
  withContext(ctx: LogContext): Logger {
    return new Logger(this.prefix, { ...this.context, ...ctx });
  }
}

export const logger = new Logger();
export type { LogLevel, LogContext, Logger, TerminalStream };

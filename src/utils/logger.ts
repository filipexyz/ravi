import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

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
  debug: "\x1b[36m",  // cyan
  info: "\x1b[32m",   // green
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
  context: "\x1b[35m", // magenta
};

// Log file path
const LOG_DIR = join(homedir(), ".ravi", "logs");
const LOG_FILE = join(LOG_DIR, "ravi.log");

/** Context that persists across log calls */
interface LogContext {
  sessionKey?: string;
  agentId?: string;
  [key: string]: unknown;
}

class Logger {
  private static globalLevel: LogLevel = "info";
  private static fileLogging = false;
  private prefix: string;
  private context: LogContext;

  constructor(prefix = "ravi", context: LogContext = {}) {
    this.prefix = prefix;
    this.context = context;
  }

  static setGlobalLevel(level: LogLevel): void {
    Logger.globalLevel = level;
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

  private formatForTerminal(level: LogLevel, message: string, data?: unknown): string {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8); // HH:MM:SS
    const color = COLORS[level];
    const levelStr = level.toUpperCase().padEnd(5);

    // Build context string from persistent context + data
    const merged = { ...this.context, ...(typeof data === "object" && data ? data : {}) };
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
        // Truncate long values
        const truncated = val.length > 50 ? val.slice(0, 47) + "..." : val;
        contextParts.push(`${k}=${truncated}`);
      }
    }

    const contextStr = contextParts.length > 0
      ? ` ${COLORS.dim}${contextParts.join(" ")}${COLORS.reset}`
      : "";

    return `${COLORS.dim}${time}${COLORS.reset} ${color}${levelStr}${COLORS.reset} [${this.prefix}] ${message}${contextStr}`;
  }

  private formatForFile(level: LogLevel, message: string, data?: unknown): string {
    const timestamp = new Date().toISOString();
    const merged = { ...this.context, ...(typeof data === "object" && data ? data : {}) };

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

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const terminalLine = this.formatForTerminal(level, message, data);
    const fileLine = this.formatForFile(level, message, data);

    switch (level) {
      case "debug":
        console.debug(terminalLine);
        break;
      case "info":
        console.info(terminalLine);
        break;
      case "warn":
        console.warn(terminalLine);
        break;
      case "error":
        console.error(terminalLine);
        break;
    }

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
    // Extract stack trace from Error objects
    let errorData = data;
    if (data instanceof Error) {
      errorData = {
        error: data.message,
        stack: data.stack?.split("\n").slice(1, 4).map(s => s.trim()),
      };
    } else if (typeof data === "object" && data !== null) {
      const d = data as Record<string, unknown>;
      if (d.error instanceof Error) {
        errorData = {
          ...d,
          error: d.error.message,
          stack: d.error.stack?.split("\n").slice(1, 4).map(s => s.trim()),
        };
      }
    }
    this.log("error", message, errorData);
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
export type { LogLevel, LogContext, Logger };

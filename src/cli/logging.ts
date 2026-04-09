import { logger, type LogLevel } from "../utils/logger.js";

const CLI_LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

export function resolveCliLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = env.RAVI_CLI_LOG_LEVEL?.trim().toLowerCase();
  if (raw && CLI_LOG_LEVELS.has(raw as LogLevel)) {
    return raw as LogLevel;
  }
  return "error";
}

export function configureCliLogging(env: NodeJS.ProcessEnv = process.env): void {
  logger.setTerminalStream("stderr");
  logger.setLevel(resolveCliLogLevel(env));
}

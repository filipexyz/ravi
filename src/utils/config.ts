export interface Config {
  /** ANTHROPIC_API_KEY for Claude API access */
  apiKey: string;
  /** Model to use (default: claude-sonnet-4-20250514) */
  model: string;
  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(): Config {
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    model: process.env.RAVI_MODEL || "sonnet",
    logLevel: (process.env.RAVI_LOG_LEVEL as Config["logLevel"]) || "info",
  };
}

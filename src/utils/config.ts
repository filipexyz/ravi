export interface Config {
  /** ANTHROPIC_API_KEY for Claude API access */
  apiKey: string;
  /**
   * Env-only model fallback (`RAVI_MODEL` or hardcoded `sonnet`).
   * Not the live runtime default — use `resolveRuntimeDefaults()` for the
   * next-turn selection. Stored settings win over this value.
   */
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

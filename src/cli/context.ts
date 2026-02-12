/**
 * CLI Tool Context
 *
 * Provides async-safe context propagation for CLI tools using AsyncLocalStorage.
 * Tools can access session info, channel context, and other metadata without
 * explicit parameter passing.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Context available to CLI tools during execution
 */
export interface ToolContext {
  /** Current session key (DB primary key) */
  sessionKey?: string;
  /** Current session name (human-readable) */
  sessionName?: string;
  /** Agent ID */
  agentId?: string;
  /** Channel info for response routing */
  source?: {
    channel: string;
    accountId: string;
    chatId: string;
  };
  /** Arbitrary metadata */
  [key: string]: unknown;
}

/**
 * AsyncLocalStorage instance for tool context
 */
const contextStorage = new AsyncLocalStorage<ToolContext>();

/**
 * Run a function with tool context.
 * Context is automatically propagated through async operations.
 *
 * @example
 * await runWithContext({ sessionKey: "agent:main:main" }, async () => {
 *   // Tools called here can access the context
 *   await query({ prompt, options });
 * });
 */
export function runWithContext<T>(context: ToolContext, fn: () => T): T {
  return contextStorage.run(context, fn);
}

/**
 * Get current tool context.
 * First checks AsyncLocalStorage (in-process), then falls back to RAVI_* env vars
 * (when running as subprocess via Bash).
 *
 * @example
 * const ctx = getContext();
 * const sessionKey = ctx?.sessionKey ?? "unknown";
 */
export function getContext(): ToolContext | undefined {
  const store = contextStorage.getStore();
  if (store) return store;

  // Fallback: build context from RAVI_* env vars (set when running via Bash in SDK)
  const env = process.env;
  if (!env.RAVI_SESSION_KEY && !env.RAVI_SESSION_NAME) return undefined;

  const ctx: ToolContext = {
    sessionKey: env.RAVI_SESSION_KEY,
    sessionName: env.RAVI_SESSION_NAME,
    agentId: env.RAVI_AGENT_ID,
  };

  if (env.RAVI_CHANNEL && env.RAVI_ACCOUNT_ID && env.RAVI_CHAT_ID) {
    ctx.source = {
      channel: env.RAVI_CHANNEL,
      accountId: env.RAVI_ACCOUNT_ID,
      chatId: env.RAVI_CHAT_ID,
    };
  }

  return ctx;
}

/**
 * Get a specific value from context with type safety.
 *
 * @example
 * const sessionKey = getContextValue("sessionKey");
 */
export function getContextValue<K extends keyof ToolContext>(
  key: K
): ToolContext[K] | undefined {
  return contextStorage.getStore()?.[key];
}

/**
 * Check if running within a tool context (in-process or via env vars).
 */
export function hasContext(): boolean {
  return contextStorage.getStore() !== undefined || !!process.env.RAVI_SESSION_KEY || !!process.env.RAVI_SESSION_NAME;
}

/**
 * Fail with error. Throws if running inside daemon context,
 * otherwise logs error and exits.
 */
export function fail(message: string): never {
  if (hasContext()) {
    throw new Error(message);
  }
  console.error(message);
  process.exit(1);
}

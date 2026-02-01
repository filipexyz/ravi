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
  /** Current session key (e.g., "agent:main:dm:5511999") */
  sessionKey?: string;
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
 * Returns undefined if called outside a context.
 *
 * @example
 * const ctx = getContext();
 * const sessionKey = ctx?.sessionKey ?? "unknown";
 */
export function getContext(): ToolContext | undefined {
  return contextStorage.getStore();
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
 * Check if running within a tool context.
 */
export function hasContext(): boolean {
  return contextStorage.getStore() !== undefined;
}

/**
 * Fail with error. Throws if running as MCP tool (to avoid killing daemon),
 * otherwise logs error and exits.
 */
export function fail(message: string): never {
  if (hasContext()) {
    throw new Error(message);
  }
  console.error(message);
  process.exit(1);
}

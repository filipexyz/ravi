/**
 * CLI Tool Context
 *
 * Provides async-safe context propagation for CLI tools using AsyncLocalStorage.
 * Tools can access session info, channel context, and other metadata without
 * explicit parameter passing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeContextFromEnv, resolveRuntimeContext, RAVI_CONTEXT_KEY_ENV } from "../runtime/context-registry.js";
import type { ContextRecord } from "../router/router-db.js";
import { readCredentialsFile, selectDefaultCredentialsKey } from "../runtime/credentials-store.js";
import { CliExpectedError } from "./expected-error.js";

/**
 * Context available to CLI tools during execution
 */
export interface ToolContext {
  /** Execution surface for commands that have transport-specific interaction constraints. */
  transport?: "tool" | "gateway";
  /** Current runtime context ID */
  contextId?: string;
  /** Resolved context registry record */
  context?: ContextRecord;
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
    instanceId?: string;
    chatId: string;
    threadId?: string;
    canonicalChatId?: string;
  };
  /** Arbitrary metadata */
  [key: string]: unknown;
  /** Suppress human CLI stdout when commands are executed through another surface. */
  suppressCliOutput?: boolean;
}

/**
 * AsyncLocalStorage instance for tool context
 */
const contextStorage = new AsyncLocalStorage<ToolContext>();
const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);
let consoleGateInstalled = false;

installContextualConsoleGate();

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
export function getContext(options: { localOnly?: boolean } = {}): ToolContext | undefined {
  const store = contextStorage.getStore();
  if (store) return store;
  if (options.localOnly === true) return undefined;

  const env = process.env;

  // Resolution order:
  //  1. RAVI_CONTEXT_KEY env var (already handled by getRuntimeContextFromEnv)
  //  2. ~/.ravi/credentials.json `default` entry
  //  3. Legacy RAVI_AGENT_ID / RAVI_SESSION_* fallback (TODO: remove once sdk/auth fully lands)
  const resolvedContext = getRuntimeContextFromEnv(env) ?? resolveDefaultCredential();
  if (resolvedContext) {
    const ctx: ToolContext = {
      contextId: resolvedContext.contextId,
      context: resolvedContext,
      sessionKey: resolvedContext.sessionKey ?? env.RAVI_SESSION_KEY,
      sessionName: resolvedContext.sessionName ?? env.RAVI_SESSION_NAME,
      agentId: resolvedContext.agentId ?? env.RAVI_AGENT_ID,
    };

    const source = resolvedContext.source;
    if (source) {
      ctx.source = {
        channel: source.channel,
        accountId: source.accountId,
        ...(env.RAVI_INSTANCE_ID ? { instanceId: env.RAVI_INSTANCE_ID } : {}),
        chatId: source.chatId,
        ...(source.threadId ? { threadId: source.threadId } : {}),
        ...(env.RAVI_CANONICAL_CHAT_ID ? { canonicalChatId: env.RAVI_CANONICAL_CHAT_ID } : {}),
      };
    } else if (env.RAVI_CHANNEL && env.RAVI_ACCOUNT_ID && env.RAVI_CHAT_ID) {
      ctx.source = {
        channel: env.RAVI_CHANNEL,
        accountId: env.RAVI_ACCOUNT_ID,
        ...(env.RAVI_INSTANCE_ID ? { instanceId: env.RAVI_INSTANCE_ID } : {}),
        chatId: env.RAVI_CHAT_ID,
        ...(env.RAVI_THREAD_ID ? { threadId: env.RAVI_THREAD_ID } : {}),
        ...(env.RAVI_CANONICAL_CHAT_ID ? { canonicalChatId: env.RAVI_CANONICAL_CHAT_ID } : {}),
      };
    }

    return ctx;
  }

  // Fallback: build context from legacy RAVI_* env vars (set when running via Bash in SDK)
  // TODO(sdk/auth): drop this fallback once all callers issue runtime context-keys.
  if (!env.RAVI_SESSION_KEY && !env.RAVI_SESSION_NAME && !env.RAVI_AGENT_ID) return undefined;

  const ctx: ToolContext = {
    sessionKey: env.RAVI_SESSION_KEY,
    sessionName: env.RAVI_SESSION_NAME,
    agentId: env.RAVI_AGENT_ID,
  };

  if (env.RAVI_CHANNEL && env.RAVI_ACCOUNT_ID && env.RAVI_CHAT_ID) {
    ctx.source = {
      channel: env.RAVI_CHANNEL,
      accountId: env.RAVI_ACCOUNT_ID,
      ...(env.RAVI_INSTANCE_ID ? { instanceId: env.RAVI_INSTANCE_ID } : {}),
      chatId: env.RAVI_CHAT_ID,
      ...(env.RAVI_THREAD_ID ? { threadId: env.RAVI_THREAD_ID } : {}),
      ...(env.RAVI_CANONICAL_CHAT_ID ? { canonicalChatId: env.RAVI_CANONICAL_CHAT_ID } : {}),
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
export function getContextValue<K extends keyof ToolContext>(key: K): ToolContext[K] | undefined {
  return getContext()?.[key];
}

/**
 * Check whether any in-process CLI context or explicit runtime env is active.
 */
export function hasContext(): boolean {
  return contextStorage.getStore() !== undefined || hasRuntimeContextEnv();
}

/**
 * Check whether the current command came from an explicit runtime invocation.
 *
 * A generic CLI handler also runs inside AsyncLocalStorage so expected command
 * failures can be normalized at the registry boundary. That handler context is
 * not enough to prove the command is running inside the daemon. Runtime tools,
 * gateway calls, and child CLIs carrying explicit runtime env are.
 */
export function hasRuntimeInvocationContext(): boolean {
  const transport = contextStorage.getStore()?.transport;
  return transport === "tool" || transport === "gateway" || hasRuntimeContextEnv();
}

function hasRuntimeContextEnv(): boolean {
  return (
    !!process.env[RAVI_CONTEXT_KEY_ENV] ||
    !!process.env.RAVI_SESSION_KEY ||
    !!process.env.RAVI_SESSION_NAME ||
    !!process.env.RAVI_AGENT_ID
  );
}

function resolveDefaultCredential(): ContextRecord | undefined {
  let key: string | null;
  try {
    key = selectDefaultCredentialsKey(readCredentialsFile());
  } catch {
    return undefined;
  }
  if (!key) return undefined;
  const record = resolveRuntimeContext(key, { touch: false });
  return record ?? undefined;
}

function installContextualConsoleGate(): void {
  if (consoleGateInstalled) return;
  consoleGateInstalled = true;
  console.log = (...args: unknown[]) => {
    if (contextStorage.getStore()?.suppressCliOutput === true) return;
    originalConsoleLog(...args);
  };
  console.info = (...args: unknown[]) => {
    if (contextStorage.getStore()?.suppressCliOutput === true) return;
    originalConsoleInfo(...args);
  };
}

/**
 * Fail with error. Throws if running inside daemon context,
 * otherwise logs error and exits.
 */
export function fail(message: string): never {
  if (hasContext()) {
    throw new CliExpectedError(message);
  }
  console.error(message);
  process.exit(1);
}

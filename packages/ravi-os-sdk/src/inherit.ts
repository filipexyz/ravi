import { RaviClient } from "./client.js";
import { createHttpTransport, type HttpTransportConfig } from "./transport/http.js";
import type { ContextIssueInput } from "./types.js";

export type RaviInheritedClientEnv = Record<string, string | undefined>;

export interface InheritedClientChildOptions extends Omit<ContextIssueInput, "cliName"> {
  cliName: string;
}

export interface CreateInheritedClientOptions {
  /** Explicit gateway base URL. Falls back to Ravi runtime env. */
  baseUrl?: string;
  /** Explicit context key. Falls back to `RAVI_CONTEXT_KEY`. */
  contextKey?: string;
  /** Optional env override for tests or custom launchers. Defaults to `process.env`. */
  env?: RaviInheritedClientEnv;
  /** Optional fetch override passed to `createHttpTransport`. */
  fetch?: typeof fetch;
  /** Request timeout in ms. `0` = no timeout. */
  timeoutMs?: number;
  /** Extra headers merged into every SDK request. */
  headers?: Record<string, string>;
  /**
   * Optional child context mode. Use only when handing context to another
   * process/subsystem; default mode reuses the current runtime context.
   */
  child?: InheritedClientChildOptions;
}

export interface InheritedClientResult {
  client: RaviClient;
  baseUrl: string;
  mode: "current" | "child";
  /** Present only in child mode. This is safe to log; the context key is not returned. */
  contextId?: string;
  /** Present only in child mode. Revokes the issued child context through the parent context. */
  revoke?: (reason?: string) => Promise<void>;
}

export async function createInheritedClient(options: CreateInheritedClientOptions = {}): Promise<InheritedClientResult> {
  const env = options.env ?? defaultEnv();
  const baseUrl = resolveInheritedBaseUrl(env, options.baseUrl);
  const contextKey = resolveInheritedContextKey(env, options.contextKey);
  const parent = new RaviClient(createHttpTransport(httpConfig(options, baseUrl, contextKey)));

  if (!options.child) {
    return { client: parent, baseUrl, mode: "current" };
  }

  const issueInput = buildChildIssueInput(options.child);
  const issued = await parent.context.issue(issueInput.cliName, {
    ...(issueInput.allow ? { allow: issueInput.allow } : {}),
    ...(issueInput.inherit !== undefined ? { inherit: issueInput.inherit } : {}),
    ...(issueInput.ttl ? { ttl: issueInput.ttl } : {}),
  });
  const child = new RaviClient(createHttpTransport(httpConfig(options, baseUrl, issued.contextKey)));

  return {
    client: child,
    baseUrl,
    mode: "child",
    contextId: issued.contextId,
    revoke: async (reason = "createInheritedClient child context cleanup") => {
      await parent.context.revoke(issued.contextId, { reason });
    },
  };
}

export function resolveInheritedBaseUrl(env: RaviInheritedClientEnv = defaultEnv(), explicit?: string): string {
  const direct = firstNonEmpty(explicit, env.RAVI_BASE_URL, env.RAVI_HTTP_BASE_URL, env.RAVI_GATEWAY_URL);
  if (direct) return normalizeBaseUrl(direct);

  const port = firstNonEmpty(env.RAVI_HTTP_PORT, env.RAVI_WEBHOOK_PORT);
  if (port) {
    const host = normalizeHost(firstNonEmpty(env.RAVI_HTTP_HOST, env.RAVI_WEBHOOK_HOST) ?? "127.0.0.1");
    return normalizeBaseUrl(`http://${host}:${port}`);
  }

  throw new Error(
    "createInheritedClient: missing Ravi gateway URL. Set RAVI_BASE_URL, RAVI_GATEWAY_URL, or RAVI_HTTP_HOST/RAVI_HTTP_PORT.",
  );
}

export function resolveInheritedContextKey(env: RaviInheritedClientEnv = defaultEnv(), explicit?: string): string {
  const contextKey = firstNonEmpty(explicit, env.RAVI_CONTEXT_KEY);
  if (!contextKey) {
    throw new Error("createInheritedClient: missing Ravi runtime context. Set RAVI_CONTEXT_KEY or pass contextKey.");
  }
  return contextKey;
}

function buildChildIssueInput(child: InheritedClientChildOptions): ContextIssueInput {
  const cliName = firstNonEmpty(child.cliName);
  if (!cliName) {
    throw new Error("createInheritedClient: child mode requires a non-empty cliName.");
  }

  const allow = firstNonEmpty(child.allow);
  const ttl = firstNonEmpty(child.ttl);
  if (!allow && child.inherit !== true) {
    throw new Error("createInheritedClient: child mode requires child.inherit === true or a non-empty child.allow.");
  }

  return {
    cliName,
    ...(allow ? { allow } : {}),
    ...(child.inherit !== undefined ? { inherit: child.inherit } : {}),
    ...(ttl ? { ttl } : {}),
  };
}

function httpConfig(
  options: Pick<CreateInheritedClientOptions, "fetch" | "headers" | "timeoutMs">,
  baseUrl: string,
  contextKey: string,
): HttpTransportConfig {
  return {
    baseUrl,
    contextKey,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  };
}

function defaultEnv(): RaviInheritedClientEnv {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: RaviInheritedClientEnv };
  };
  return runtime.process?.env ?? {};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    return new URL(trimmed).toString().replace(/\/+$/, "");
  } catch {
    throw new Error(`createInheritedClient: invalid Ravi gateway URL: ${value}`);
  }
}

function normalizeHost(value: string): string {
  const host = value.trim();
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

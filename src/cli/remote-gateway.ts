/**
 * Remote gateway dispatch for the Ravi CLI.
 *
 * Spec: `runtime/context-keys`, `sdk/auth`, `sdk/gateway`.
 *
 * When `RAVI_GATEWAY_URL` is set (or, in the future, `gateway.url` from
 * `~/.ravi/config.toml`), every decorated CLI command transparently turns into
 * a `POST /api/v1/<group-segments>/<command>` request authenticated with the
 * resolved runtime context-key (`rctx_*`).
 *
 * The remote dispatcher is intentionally minimal: it builds a flat JSON body
 * (matching `src/sdk/gateway/dispatcher.ts`), forwards the response unchanged
 * (text bodies for non-JSON, pretty-printed JSON otherwise) and exits with a
 * non-zero status when the gateway returns 4xx/5xx so shell pipelines can
 * detect failure the same way they do in local mode.
 */

import { resolveRuntimeContext } from "../runtime/context-registry.js";
import { readCredentialsFile, selectDefaultCredentialsKey } from "../runtime/credentials-store.js";

export const REMOTE_GATEWAY_URL_ENV = "RAVI_GATEWAY_URL";
export const REMOTE_GATEWAY_DEFAULT_TIMEOUT_MS = 30_000;

export interface RemoteGatewayConfig {
  url: string;
  /** Source of the configuration value, used for log/error messages. */
  source: "env";
}

export function getRemoteGatewayConfig(env: NodeJS.ProcessEnv = process.env): RemoteGatewayConfig | null {
  const raw = env[REMOTE_GATEWAY_URL_ENV]?.trim();
  if (!raw) return null;
  try {
    new URL(raw);
  } catch {
    return null;
  }
  return { url: raw.replace(/\/+$/, ""), source: "env" };
}

/**
 * Resolve the runtime context-key the CLI should send as `Authorization`.
 *
 * Mirrors the local-mode resolution order so a remote invocation transparently
 * works with the same `RAVI_CONTEXT_KEY` / credentials default the user already
 * has set up.
 */
export function resolveContextKeyForRemote(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.RAVI_CONTEXT_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    return selectDefaultCredentialsKey(readCredentialsFile());
  } catch {
    return null;
  }
}

export interface RemoteDispatchInput {
  groupSegments: string[];
  command: string;
  body: Record<string, unknown>;
  config: RemoteGatewayConfig;
  contextKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface RemoteDispatchResult {
  status: number;
  ok: boolean;
  body: string;
  contentType: string | null;
}

export async function dispatchRemote(input: RemoteDispatchInput): Promise<RemoteDispatchResult> {
  const path = `/api/v1/${[...input.groupSegments, input.command].join("/")}`;
  const url = `${input.config.url}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? REMOTE_GATEWAY_DEFAULT_TIMEOUT_MS);
  try {
    const fetchFn = input.fetchImpl ?? fetch;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.contextKey}`,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      ok: response.ok,
      body: text,
      contentType: response.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * If a runtime context key resolves locally, also prove it is still live in
 * the local registry. Returns the live context-key when available so the CLI
 * can surface a friendly error instead of letting the gateway return 401.
 */
export function probeLocalRuntimeContext(contextKey: string): boolean {
  try {
    const record = resolveRuntimeContext(contextKey, { touch: false, readOnly: true });
    return Boolean(record);
  } catch {
    return false;
  }
}

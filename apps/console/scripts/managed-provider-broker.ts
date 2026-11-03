import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type BrokerRegistryEntry = {
  guestIp: string;
  instanceId: string;
  status: "active" | "revoked";
  updatedAt: string;
  vmId: string;
};

type BrokerRegistry = {
  entries: BrokerRegistryEntry[];
  schemaVersion: "ravi.managed-provider-broker.registry/v1";
  updatedAt: string;
};

export type ManagedProviderBrokerConfig = {
  credentialPath: string;
  hostname: string;
  maxBodyBytes: number;
  maxConcurrentGlobal: number;
  maxConcurrentPerSource: number;
  port: number;
  probeTtlMs: number;
  registryPath: string;
  upstreamResponsesUrl: string;
};

type BrokerDependencies = {
  fetchImpl?: typeof fetch;
  logger?: (event: string, payload: Record<string, unknown>) => void;
  now?: () => Date;
  providerApiKey?: string;
};

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,239}$/;

export class ManagedProviderBroker {
  private readonly activeBySource = new Map<string, number>();
  private activeGlobal = 0;
  private healthCheckedAt = Number.NEGATIVE_INFINITY;
  private healthOk = false;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: (event: string, payload: Record<string, unknown>) => void;
  private readonly now: () => Date;
  private readonly providerApiKey: string;

  private constructor(
    private readonly config: ManagedProviderBrokerConfig,
    dependencies: BrokerDependencies,
    providerApiKey: string,
  ) {
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.logger = dependencies.logger ?? safeLog;
    this.now = dependencies.now ?? (() => new Date());
    this.providerApiKey = providerApiKey;
  }

  static async create(
    config: ManagedProviderBrokerConfig,
    dependencies: BrokerDependencies = {},
  ) {
    validateBrokerConfig(config);
    const providerApiKey = dependencies.providerApiKey
      ?? await readProviderApiKey(config.credentialPath);
    validateProviderApiKey(providerApiKey);
    return new ManagedProviderBroker(config, dependencies, providerApiKey);
  }

  async handle(request: Request, sourceAddress: string | null): Promise<Response> {
    const startedAt = performance.now();
    const source = normalizeSourceAddress(sourceAddress);
    const pathname = new URL(request.url).pathname;
    const isHealthCheck = request.method === "GET"
      && isExactPath(request.url, "/health");
    let status = 500;
    try {
      const isHostHealthCheck = source === "127.0.0.1" && isHealthCheck;
      if (
        !source
        || (!isHostHealthCheck && !(await this.isAuthorizedSource(source)))
      ) {
        status = 403;
        return jsonResponse(status, "provider_broker_source_denied");
      }
      if (!this.reserve(source)) {
        status = 429;
        return jsonResponse(status, "provider_broker_capacity_exceeded");
      }
      try {
        if (isHealthCheck) {
          const healthy = await this.providerHealthy();
          status = healthy ? 200 : 503;
          return Response.json(
            { ok: healthy, ready: healthy },
            { headers: noStoreHeaders(), status },
          );
        }
        if (
          request.method !== "POST"
          || !isExactPath(request.url, "/v1/responses")
        ) {
          status = 403;
          return jsonResponse(status, "provider_broker_route_denied");
        }
        const contentType = request.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          status = 415;
          return jsonResponse(status, "provider_broker_content_type_invalid");
        }
        const declaredLength = parseContentLength(request.headers.get("content-length"));
        if (declaredLength !== null && declaredLength > this.config.maxBodyBytes) {
          status = 413;
          return jsonResponse(status, "provider_broker_body_too_large");
        }
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength === 0 || body.byteLength > this.config.maxBodyBytes) {
          status = body.byteLength === 0 ? 400 : 413;
          return jsonResponse(
            status,
            body.byteLength === 0
              ? "provider_broker_body_invalid"
              : "provider_broker_body_too_large",
          );
        }
        const upstreamHeaders = requestHeaders(request.headers);
        upstreamHeaders.set("authorization", `Bearer ${this.providerApiKey}`);
        const upstream = await this.fetchImpl(this.config.upstreamResponsesUrl, {
          body,
          headers: upstreamHeaders,
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(10 * 60 * 1_000),
        });
        status = upstream.status;
        return new Response(upstream.body, {
          headers: responseHeaders(upstream.headers),
          status: upstream.status,
          statusText: upstream.statusText,
        });
      } finally {
        this.release(source);
      }
    } catch {
      status = 503;
      return jsonResponse(status, "provider_broker_upstream_unavailable");
    } finally {
      this.logger("managed_provider_broker_request", {
        durationMs: Math.round(performance.now() - startedAt),
        method: request.method.slice(0, 12),
        path: pathname.slice(0, 80),
        sourceRef: source ? shortHash(source) : null,
        status,
      });
    }
  }

  private async isAuthorizedSource(source: string) {
    const registry = await readRegistry(this.config.registryPath);
    return registry.entries.some(
      (entry) => entry.guestIp === source && entry.status === "active",
    );
  }

  private reserve(source: string) {
    const activeForSource = this.activeBySource.get(source) ?? 0;
    if (
      this.activeGlobal >= this.config.maxConcurrentGlobal
      || activeForSource >= this.config.maxConcurrentPerSource
    ) {
      return false;
    }
    this.activeGlobal += 1;
    this.activeBySource.set(source, activeForSource + 1);
    return true;
  }

  private release(source: string) {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    const activeForSource = Math.max(0, (this.activeBySource.get(source) ?? 1) - 1);
    if (activeForSource === 0) this.activeBySource.delete(source);
    else this.activeBySource.set(source, activeForSource);
  }

  private async providerHealthy() {
    const now = this.now().getTime();
    if (now - this.healthCheckedAt < this.config.probeTtlMs) return this.healthOk;
    this.healthCheckedAt = now;
    try {
      const upstream = new URL(this.config.upstreamResponsesUrl);
      upstream.pathname = "/v1/models";
      upstream.search = "";
      const response = await this.fetchImpl(upstream, {
        headers: { authorization: `Bearer ${this.providerApiKey}` },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      this.healthOk = response.ok;
    } catch {
      this.healthOk = false;
    }
    return this.healthOk;
  }
}

export function loadManagedProviderBrokerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ManagedProviderBrokerConfig {
  return {
    credentialPath: requiredAbsoluteEnv(env, "RAVI_PROVIDER_API_KEY_FILE"),
    hostname: env.RAVI_PROVIDER_BROKER_HOST?.trim() || "0.0.0.0",
    maxBodyBytes: integerEnv(env, "RAVI_PROVIDER_BROKER_MAX_BODY_BYTES", 4 * 1024 * 1024, 1_024, 16 * 1024 * 1024),
    maxConcurrentGlobal: integerEnv(env, "RAVI_PROVIDER_BROKER_MAX_CONCURRENT", 32, 1, 256),
    maxConcurrentPerSource: integerEnv(env, "RAVI_PROVIDER_BROKER_MAX_CONCURRENT_PER_SOURCE", 4, 1, 32),
    port: integerEnv(env, "RAVI_PROVIDER_BROKER_PORT", 7443, 1_024, 65_535),
    probeTtlMs: integerEnv(env, "RAVI_PROVIDER_BROKER_PROBE_TTL_MS", 60_000, 5_000, 300_000),
    registryPath: requiredAbsoluteEnv(
      env,
      "RAVI_PROVIDER_BROKER_REGISTRY",
      "/var/lib/ravi-runtime-control/provider-broker/instances.json",
    ),
    upstreamResponsesUrl: "https://api.openai.com/v1/responses",
  };
}

async function readProviderApiKey(filePath: string) {
  try {
    return (await readFile(filePath, "utf8")).trim();
  } catch {
    throw new Error("provider_broker_credential_unavailable");
  }
}

async function readRegistry(filePath: string): Promise<BrokerRegistry> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error("provider_broker_registry_unavailable");
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== "ravi.managed-provider-broker.registry/v1"
    || typeof value.updatedAt !== "string"
    || !Array.isArray(value.entries)
    || !value.entries.every(isRegistryEntry)
  ) {
    throw new Error("provider_broker_registry_invalid");
  }
  return value as BrokerRegistry;
}

function isRegistryEntry(value: unknown): value is BrokerRegistryEntry {
  return isRecord(value)
    && isIpv4(value.guestIp)
    && typeof value.instanceId === "string"
    && SAFE_ID_RE.test(value.instanceId)
    && (value.status === "active" || value.status === "revoked")
    && typeof value.updatedAt === "string"
    && typeof value.vmId === "string"
    && SAFE_ID_RE.test(value.vmId);
}

function validateBrokerConfig(config: ManagedProviderBrokerConfig) {
  const upstream = new URL(config.upstreamResponsesUrl);
  if (
    upstream.protocol !== "https:"
    || upstream.hostname !== "api.openai.com"
    || upstream.pathname !== "/v1/responses"
    || upstream.search
    || upstream.hash
  ) {
    throw new Error("provider_broker_upstream_invalid");
  }
}

function validateProviderApiKey(value: string) {
  if (
    value.length < 20
    || value.length > 512
    || /\s/.test(value)
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new Error("provider_broker_credential_invalid");
  }
}

function normalizeSourceAddress(value: string | null) {
  if (!value) return null;
  const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
  return isIpv4(normalized) ? normalized : null;
}

function isIpv4(value: unknown): value is string {
  if (typeof value !== "string" || !IPV4_RE.test(value)) return false;
  return value.split(".").every((part) => Number(part) <= 255);
}

function isExactPath(urlValue: string, pathname: string) {
  const url = new URL(urlValue);
  return url.pathname === pathname && !url.search && !url.hash;
}

function parseContentLength(value: string | null) {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return Number.POSITIVE_INFINITY;
  return Number(value);
}

function responseHeaders(headers: Headers) {
  const output = noStoreHeaders();
  for (const [name, value] of headers) {
    if (!RESPONSE_HEADER_DENYLIST.has(name.toLowerCase())) {
      output.append(name, value);
    }
  }
  return output;
}

const REQUEST_HEADER_DENYLIST = new Set([
  "api-key",
  "authorization",
  "chatgpt-account-id",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "openai-organization",
  "openai-project",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-api-key",
]);

const RESPONSE_HEADER_DENYLIST = new Set([
  "authorization",
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestHeaders(headers: Headers) {
  const output = new Headers();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      !REQUEST_HEADER_DENYLIST.has(lower)
      && !lower.startsWith("cf-")
      && !lower.startsWith("x-forwarded-")
    ) {
      output.append(name, value);
    }
  }
  if (!output.has("accept")) output.set("accept", "text/event-stream");
  return output;
}

function noStoreHeaders() {
  return new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

function jsonResponse(status: number, code: string) {
  return Response.json(
    { code, ok: false },
    { headers: noStoreHeaders(), status },
  );
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredAbsoluteEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
) {
  const value = env[name]?.trim() || fallback;
  if (!value || !value.startsWith("/")) {
    throw new Error("provider_broker_config_invalid");
  }
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error("provider_broker_config_invalid");
  }
  return value;
}

function safeLog(event: string, payload: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ event, ...payload })}\n`);
}

async function main() {
  const config = loadManagedProviderBrokerConfig();
  const broker = await ManagedProviderBroker.create(config);
  Bun.serve({
    fetch(request, server) {
      return broker.handle(request, server.requestIP(request)?.address ?? null);
    },
    hostname: config.hostname,
    port: config.port,
  });
  safeLog("managed_provider_broker_ready", {
    hostname: config.hostname,
    port: config.port,
  });
}

if (import.meta.main) {
  await main();
}

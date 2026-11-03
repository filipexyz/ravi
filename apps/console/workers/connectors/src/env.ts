/**
 * Runtime environment for the `ravi-connectors` Worker.
 *
 * Only the Worker itself receives this binding set. The root wrap key,
 * Vercel HMAC keys, provider OAuth secrets, and Postgres credentials never
 * leave Cloudflare Secrets Store + Hyperdrive.
 */
export interface ConnectorsWorkerEnv {
  // Postgres via Hyperdrive. Wrangler injects this binding.
  RAVI_CONSOLE_DB: HyperdriveBinding;

  // Durable Object namespaces for unwrap rate-limit counters.
  RAVI_CONNECTORS_RATE_LIMIT_ORG: DurableObjectNamespace;
  RAVI_CONNECTORS_RATE_LIMIT_CONN: DurableObjectNamespace;

  // Secrets (set via `wrangler secret put`).
  RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64: string;
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT: string;
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID: string;
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_PREVIOUS?: string;
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_PREVIOUS_ID?: string;
  RAVI_CONNECTORS_CLI_ACCESS_TOKEN_SECRET: string;
  GOOGLE_OAUTH_CLIENT_ID: string;
  GOOGLE_OAUTH_CLIENT_SECRET: string;
  WORKOS_API_KEY: string;

  // Plain configuration vars.
  RAVI_CONSOLE_BASE_URL: string;
  RAVI_CONNECTORS_BASE_URL: string;
  RAVI_CONNECTORS_KEY_VERSION: string;
  RAVI_CONNECTORS_PENDING_GRANT_TTL_SECONDS: string;
  RAVI_CONNECTORS_STEPUP_TTL_SECONDS: string;
  RAVI_CONNECTORS_REAUTH_AFTER_DAYS: string;
  RAVI_CONNECTORS_SUSPEND_AFTER_DAYS: string;
}

export interface HyperdriveBinding {
  readonly connectionString: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

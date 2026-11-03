export interface McpWorkerEnv {
  RAVI_CONSOLE_DB: HyperdriveBinding;
  RAVI_MCP_RATE_LIMIT_BRIDGE: DurableObjectNamespace;
  RAVI_MCP_RATE_LIMIT_CLIENT: DurableObjectNamespace;

  RAVI_MCP_WORKER_HMAC_KEY_CURRENT: string;
  RAVI_MCP_WORKER_HMAC_KEY_CURRENT_ID: string;
  RAVI_MCP_WORKER_HMAC_KEY_PREVIOUS?: string;
  RAVI_MCP_WORKER_HMAC_KEY_PREVIOUS_ID?: string;

  RAVI_CONSOLE_BASE_URL: string;
  RAVI_MCP_BASE_URL: string;
  RAVI_MCP_DEFAULT_BRIDGE_RATE_LIMIT_PER_MINUTE: string;
  RAVI_MCP_DEFAULT_CLIENT_RATE_LIMIT_PER_HOUR: string;
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

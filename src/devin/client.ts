export type DevinSessionStatus =
  | "new"
  | "creating"
  | "claimed"
  | "running"
  | "exit"
  | "error"
  | "suspended"
  | "resuming"
  | string;

export interface DevinPullRequest {
  pr_state: string;
  pr_url: string;
}

export interface DevinSession {
  acus_consumed: number;
  created_at: number;
  org_id: string;
  pull_requests: DevinPullRequest[];
  session_id: string;
  status: DevinSessionStatus;
  tags: string[];
  updated_at: number;
  url: string;
  child_session_ids?: string[] | null;
  is_advanced?: boolean;
  is_archived?: boolean;
  parent_session_id?: string | null;
  playbook_id?: string | null;
  service_user_id?: string | null;
  status_detail?: string | null;
  structured_output?: Record<string, unknown> | null;
  title?: string | null;
  user_id?: string | null;
}

export interface DevinSessionMessage {
  created_at: number;
  event_id: string;
  message: string;
  source: "devin" | "user" | string;
}

export interface DevinSessionAttachment {
  attachment_id: string;
  name: string;
  source: "devin" | "user" | string;
  url: string;
  content_type: string | null;
}

export interface DevinSessionInsights extends DevinSession {
  analysis?: Record<string, unknown> | null;
  num_devin_messages?: number | null;
  num_user_messages?: number | null;
  session_size?: string | null;
}

export interface DevinPage<T> {
  items: T[];
  end_cursor?: string | null;
  has_next_page?: boolean;
  total?: number | null;
}

export interface DevinSelf {
  principal_type?: string;
  service_user_id?: string;
  service_user_name?: string;
  org_id?: string;
  [key: string]: unknown;
}

export interface DevinClientConfig {
  apiKey: string;
  orgId: string;
  baseUrl?: string;
  fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface CreateDevinSessionInput {
  prompt: string;
  title?: string;
  tags?: string[];
  advanced_mode?: string;
  attachment_urls?: string[];
  bypass_approval?: boolean;
  child_playbook_id?: string;
  create_as_user_id?: string;
  knowledge_ids?: string[];
  max_acu_limit?: number;
  playbook_id?: string;
  repos?: string[];
  secret_ids?: string[];
  session_links?: string[];
  structured_output_schema?: Record<string, unknown>;
}

export interface ListDevinSessionsInput {
  first?: number;
  after?: string;
  tags?: string[];
  session_ids?: string[];
}

export interface ListDevinMessagesInput {
  first?: number;
  after?: string;
}

export class DevinConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevinConfigError";
  }
}

export class DevinApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "DevinApiError";
    this.status = status;
    this.body = body;
    this.code = mapHttpStatusToCode(status);
  }
}

function mapHttpStatusToCode(status: number): string {
  if (status === 401) return "devin.auth.invalid";
  if (status === 403) return "devin.auth.forbidden";
  if (status === 404) return "devin.not_found";
  if (status === 429) return "devin.rate_limited";
  if (status === 400 || status === 422) return "devin.validation_failed";
  if (status >= 500) return "devin.server_error";
  return "devin.api_error";
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl?.trim() || "https://api.devin.ai/v3").replace(/\/+$/, "");
}

function parseJson(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getApiErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "detail", "error"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return fallback;
}

function appendQuery(url: URL, query?: Record<string, string | number | boolean | string[] | undefined>): void {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item.trim()) url.searchParams.append(key, item);
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

export function toDevinApiId(devinId: string): string {
  const normalized = devinId.trim();
  if (!normalized) {
    throw new DevinConfigError(`Invalid Devin session id: ${devinId}`);
  }
  return normalized.startsWith("devin-") ? normalized : `devin-${normalized}`;
}

export function createDevinClientFromEnv(env: NodeJS.ProcessEnv = process.env): DevinClient {
  const apiKey = env.DEVIN_API_KEY?.trim();
  if (!apiKey) throw new DevinConfigError("DEVIN_API_KEY is not configured.");
  if (!apiKey.startsWith("cog_")) {
    throw new DevinConfigError("DEVIN_API_KEY must be a Devin service-user key with cog_ prefix.");
  }

  const orgId = env.DEVIN_ORG_ID?.trim();
  if (!orgId) throw new DevinConfigError("DEVIN_ORG_ID is not configured.");
  if (!orgId.startsWith("org_")) {
    throw new DevinConfigError("DEVIN_ORG_ID must use the org_ prefix.");
  }

  return new DevinClient({
    apiKey,
    orgId,
    baseUrl: env.DEVIN_API_BASE_URL,
  });
}

export function getDefaultMaxAcuLimit(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env.DEVIN_DEFAULT_MAX_ACU_LIMIT?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DevinConfigError("DEVIN_DEFAULT_MAX_ACU_LIMIT must be a positive integer.");
  }
  return parsed;
}

export class DevinClient {
  readonly orgId: string;
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(config: DevinClientConfig) {
    this.apiKey = config.apiKey;
    this.orgId = config.orgId;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async self(): Promise<DevinSelf> {
    return this.request<DevinSelf>("GET", "/self");
  }

  async listSessions(input: ListDevinSessionsInput = {}): Promise<DevinPage<DevinSession>> {
    return this.request<DevinPage<DevinSession>>("GET", this.orgPath("/sessions"), {
      query: {
        first: input.first,
        after: input.after,
        tags: input.tags,
        session_ids: input.session_ids,
      },
    });
  }

  async createSession(input: CreateDevinSessionInput): Promise<DevinSession> {
    return this.request<DevinSession>("POST", this.orgPath("/sessions"), { body: compactObject(input) });
  }

  async getSession(devinId: string): Promise<DevinSession> {
    return this.request<DevinSession>("GET", this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}`));
  }

  async listMessages(devinId: string, input: ListDevinMessagesInput = {}): Promise<DevinPage<DevinSessionMessage>> {
    return this.request<DevinPage<DevinSessionMessage>>(
      "GET",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}/messages`),
      {
        query: {
          first: input.first,
          after: input.after,
        },
      },
    );
  }

  async listAllMessages(devinId: string, first = 200): Promise<DevinSessionMessage[]> {
    const messages: DevinSessionMessage[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.listMessages(devinId, { first, after });
      messages.push(...page.items);
      if (!page.has_next_page || !page.end_cursor) break;
      after = page.end_cursor;
    }
    return messages;
  }

  async sendMessage(devinId: string, message: string, messageAsUserId?: string): Promise<DevinSession> {
    return this.request<DevinSession>(
      "POST",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}/messages`),
      {
        body: compactObject({
          message,
          message_as_user_id: messageAsUserId,
        }),
      },
    );
  }

  async listAttachments(devinId: string): Promise<DevinSessionAttachment[]> {
    return this.request<DevinSessionAttachment[]>(
      "GET",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}/attachments`),
    );
  }

  async getSessionInsights(devinId: string): Promise<DevinSessionInsights> {
    return this.request<DevinSessionInsights>(
      "GET",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}/insights`),
    );
  }

  async generateSessionInsights(devinId: string): Promise<DevinSessionInsights> {
    return this.request<DevinSessionInsights>(
      "POST",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}/insights/generate`),
    );
  }

  async terminateSession(devinId: string, options: { archive?: boolean } = {}): Promise<DevinSession> {
    return this.request<DevinSession>(
      "DELETE",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}`),
      { query: options.archive ? { archive: true } : undefined },
    );
  }

  async archiveSession(devinId: string): Promise<DevinSession> {
    return this.request<DevinSession>(
      "POST",
      this.orgPath(`/sessions/${encodeURIComponent(toDevinApiId(devinId))}/archive`),
    );
  }

  private orgPath(path: string): string {
    return `/organizations/${encodeURIComponent(this.orgId)}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: Record<string, string | number | boolean | string[] | undefined>;
      body?: unknown;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    appendQuery(url, options.query);
    const response = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      throw new DevinApiError(
        getApiErrorMessage(body, `Devin API request failed with status ${response.status}`),
        response.status,
        body,
      );
    }
    return body as T;
  }
}

function compactObject<T extends object>(value: T): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (Array.isArray(item) && item.length === 0) continue;
    compacted[key] = item;
  }
  return compacted;
}

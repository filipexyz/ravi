/**
 * Cloudflare Email Routing provider for Ravi Mail.
 *
 * Wraps the Cloudflare REST API so the Console can manage Email Routing rules
 * as mailboxes are created and disabled. Each Ravi Mail mailbox maps to one
 * literal address rule on the configured zone that forwards inbound mail to
 * the Ravi Mail Cloudflare Worker.
 *
 * Required env vars:
 *   - `CLOUDFLARE_API_TOKEN` — zone-scoped token with `Email Routing Rules`
 *     Read/Edit on the managed mail zone.
 *   - `RAVI_MAIL_WORKER_NAME` (default: `ravi-mail`).
 *
 * Zone identifiers are configured explicitly via
 * `CLOUDFLARE_ZONE_ID_<DOMAIN>` env vars (dots replaced with underscores) so
 * the runtime never needs `Zone:Read` and stays narrowly permissioned.
 */

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_WORKER_NAME = "ravi-mail";

export class CloudflareEmailRoutingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CloudflareEmailRoutingError";
  }
}

export interface CloudflareEmailRoutingConfig {
  apiToken: string;
  workerName: string;
  fetchImpl?: typeof fetch;
}

export interface CloudflareRoutingRule {
  id: string;
  name: string | null;
  enabled: boolean;
  matchers: Array<{ type: "literal"; field: "to"; value: string }>;
  actions: Array<{ type: string; value: string[] }>;
}

export interface CreateAddressRuleInput {
  zoneId: string;
  address: string;
  name?: string;
}

export interface DeleteAddressRuleInput {
  zoneId: string;
  ruleId: string;
}

export interface DeleteAddressRulesByAddressInput {
  zoneId: string;
  address: string;
}

export function getCloudflareEmailRoutingConfig(env: NodeJS.ProcessEnv = process.env): CloudflareEmailRoutingConfig | null {
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!apiToken) return null;
  const workerName = env.RAVI_MAIL_WORKER_NAME?.trim() || DEFAULT_WORKER_NAME;
  return { apiToken, workerName };
}

export function createCloudflareEmailRoutingProvider(config: CloudflareEmailRoutingConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, init);
    } catch (error) {
      throw new CloudflareEmailRoutingError(
        "CF_TRANSPORT_ERROR",
        `Cloudflare request failed: ${errMessage(error)}`,
        undefined,
        { cause: error },
      );
    }

    const payload = await readBody(response);
    if (!response.ok || !isSuccessEnvelope(payload)) {
      throw mapCloudflareError(response.status, payload);
    }
    return (payload as { result: T }).result;
  }

  return {
    async lookupZoneIdByName(domain: string): Promise<string | null> {
      const escaped = encodeURIComponent(domain.trim().toLowerCase());
      const result = await request<Array<{ id: string; name: string }>>("GET", `/zones?name=${escaped}`);
      const zone = result.find((row) => row.name === domain.trim().toLowerCase());
      return zone?.id ?? null;
    },

    async createAddressRule(input: CreateAddressRuleInput): Promise<CloudflareRoutingRule> {
      const body = {
        name: input.name ?? `ravi-mail:${input.address}`,
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: input.address }],
        actions: [{ type: "worker", value: [config.workerName] }],
        priority: 0,
      };
      return request<CloudflareRoutingRule>("POST", `/zones/${input.zoneId}/email/routing/rules`, body);
    },

    async deleteAddressRule(input: DeleteAddressRuleInput): Promise<void> {
      await request<unknown>("DELETE", `/zones/${input.zoneId}/email/routing/rules/${input.ruleId}`);
    },

    async deleteAddressRulesByAddress(input: DeleteAddressRulesByAddressInput): Promise<{ deletedRuleIds: string[] }> {
      const normalizedAddress = input.address.trim().toLowerCase();
      const rules = await request<CloudflareRoutingRule[]>("GET", `/zones/${input.zoneId}/email/routing/rules`);
      const matchingRules = rules.filter((rule) =>
        rule.matchers.some(
          (matcher) =>
            matcher.type === "literal" &&
            matcher.field === "to" &&
            matcher.value.trim().toLowerCase() === normalizedAddress,
        ),
      );
      const deletedRuleIds: string[] = [];

      for (const rule of matchingRules) {
        try {
          await request<unknown>("DELETE", `/zones/${input.zoneId}/email/routing/rules/${rule.id}`);
          deletedRuleIds.push(rule.id);
        } catch (error) {
          if (error instanceof CloudflareEmailRoutingError && error.code === "CF_NOT_FOUND") continue;
          throw error;
        }
      }

      return { deletedRuleIds };
    },
  };
}

export type CloudflareEmailRoutingProvider = ReturnType<typeof createCloudflareEmailRoutingProvider>;

function isSuccessEnvelope(payload: unknown): payload is { result: unknown; success: true } {
  return Boolean(payload) && typeof payload === "object" && (payload as { success?: boolean }).success === true;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}

function mapCloudflareError(status: number, payload: unknown): CloudflareEmailRoutingError {
  const errors = (payload as { errors?: Array<{ code?: number; message?: string }> } | null)?.errors;
  const first = errors?.[0];
  const code = first?.code ? `CF_${first.code}` : statusCode(status);
  const message = first?.message ?? `Cloudflare request failed with status ${status}`;
  return new CloudflareEmailRoutingError(code, message, status, payload);
}

function statusCode(status: number): string {
  if (status === 401) return "CF_UNAUTHORIZED";
  if (status === 403) return "CF_FORBIDDEN";
  if (status === 404) return "CF_NOT_FOUND";
  if (status === 429) return "CF_RATE_LIMITED";
  if (status >= 500) return "CF_SERVER_ERROR";
  return "CF_REQUEST_FAILED";
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

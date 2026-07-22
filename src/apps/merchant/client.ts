export type MerchantOperationRisk = "read" | "write" | "destructive" | "financial";

import { resolveCredentialSecret } from "../../credentials/broker.js";

export type MerchantAuthorizationProvider = (input: {
  connection: string;
  risk: MerchantOperationRisk;
}) => Promise<string>;

export type MerchantFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MerchantClientOptions {
  connection?: string;
  fetch?: MerchantFetch;
  authorization?: MerchantAuthorizationProvider;
}

export interface MerchantListOptions {
  pageSize?: number;
  pageToken?: string;
}

const MERCHANT_API = "https://merchantapi.googleapis.com";

export class MerchantClient {
  readonly #connection: string;
  readonly #fetch: MerchantFetch;
  readonly #authorization: MerchantAuthorizationProvider;

  constructor(options: MerchantClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorization = options.authorization ?? brokerAuthorization;
  }

  listAccounts(options: MerchantListOptions = {}) {
    return this.request("accounts/v1/accounts", { query: listQuery(options) });
  }

  getAccount(accountId: string) {
    return this.request(`accounts/v1/accounts/${segment(accountId)}`);
  }

  listAccountIssues(accountId: string, options: MerchantListOptions = {}) {
    return this.request(`accounts/v1/accounts/${segment(accountId)}/issues`, { query: listQuery(options) });
  }

  listProducts(accountId: string, options: MerchantListOptions = {}) {
    return this.request(`products/v1/accounts/${segment(accountId)}/products`, { query: listQuery(options) });
  }

  getProduct(accountId: string, productId: string) {
    return this.request(`products/v1/accounts/${segment(accountId)}/products/${segment(productId)}`);
  }

  searchReports(accountId: string, body: { query: string; pageSize?: number; pageToken?: string }) {
    return this.request(`reports/v1/accounts/${segment(accountId)}/reports:search`, {
      method: "POST",
      body,
    });
  }

  listDataSources(accountId: string, options: MerchantListOptions = {}) {
    return this.request(`datasources/v1/accounts/${segment(accountId)}/dataSources`, {
      query: listQuery(options),
    });
  }

  getDataSource(accountId: string, dataSourceId: string) {
    return this.request(`datasources/v1/accounts/${segment(accountId)}/dataSources/${segment(dataSourceId)}`);
  }

  listPromotions(accountId: string, options: MerchantListOptions = {}) {
    return this.request(`promotions/v1/accounts/${segment(accountId)}/promotions`, {
      query: listQuery(options),
    });
  }

  getPromotion(accountId: string, promotionId: string) {
    return this.request(`promotions/v1/accounts/${segment(accountId)}/promotions/${segment(promotionId)}`);
  }

  insertProduct(accountId: string, dataSourceId: string, body: Record<string, unknown>) {
    return this.request(`products/v1/accounts/${segment(accountId)}/productInputs:insert`, {
      method: "POST",
      risk: "write",
      query: { dataSource: dataSourceName(accountId, dataSourceId) },
      body,
    });
  }

  patchProduct(
    accountId: string,
    productInputId: string,
    dataSourceId: string,
    updateMask: string,
    body: Record<string, unknown>,
  ) {
    const name = productInputName(accountId, productInputId);
    return this.request(`products/v1/${name}`, {
      method: "PATCH",
      risk: "write",
      query: { dataSource: dataSourceName(accountId, dataSourceId), updateMask },
      body: { ...body, name },
    });
  }

  deleteProductInput(accountId: string, productInputId: string, dataSourceId: string) {
    return this.request(`products/v1/accounts/${segment(accountId)}/productInputs/${segment(productInputId)}`, {
      method: "DELETE",
      risk: "destructive",
      query: { dataSource: dataSourceName(accountId, dataSourceId) },
    });
  }

  createDataSource(accountId: string, body: Record<string, unknown>) {
    return this.request(`datasources/v1/accounts/${segment(accountId)}/dataSources`, {
      method: "POST",
      risk: "write",
      body,
    });
  }

  updateDataSource(accountId: string, dataSourceId: string, updateMask: string, body: Record<string, unknown>) {
    const name = dataSourceName(accountId, dataSourceId);
    return this.request(`datasources/v1/${name}`, {
      method: "PATCH",
      risk: "write",
      query: { updateMask },
      body: { ...body, name },
    });
  }

  deleteDataSource(accountId: string, dataSourceId: string) {
    return this.request(`datasources/v1/${dataSourceName(accountId, dataSourceId)}`, {
      method: "DELETE",
      risk: "destructive",
    });
  }

  fetchDataSource(accountId: string, dataSourceId: string) {
    return this.request(`datasources/v1/${dataSourceName(accountId, dataSourceId)}:fetch`, {
      method: "POST",
      risk: "write",
      body: {},
    });
  }

  insertPromotion(accountId: string, dataSourceId: string, body: Record<string, unknown>) {
    return this.request(`promotions/v1/accounts/${segment(accountId)}/promotions:insert`, {
      method: "POST",
      risk: "write",
      body: { promotion: body, dataSource: dataSourceName(accountId, dataSourceId) },
    });
  }

  createOrderTrackingSignal(accountId: string, body: Record<string, unknown>) {
    return this.request(`ordertracking/v1/accounts/${segment(accountId)}/orderTrackingSignals`, {
      method: "POST",
      risk: "financial",
      body,
    });
  }

  private async request(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      risk?: MerchantOperationRisk;
      query?: Record<string, string | number | undefined>;
      body?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const risk = options.risk ?? "read";
    const accessToken = await this.#authorization({ connection: this.#connection, risk });
    if (!accessToken.trim()) throw new Error("Merchant authorization provider returned an empty access token.");

    const url = new URL(`${MERCHANT_API}/${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Google Merchant API request failed (${response.status}): ${redact(text)}`);
    }
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Google Merchant API returned a non-object JSON response.");
    }
    return parsed as Record<string, unknown>;
  }
}

async function brokerAuthorization(input: { connection: string; risk: MerchantOperationRisk }): Promise<string> {
  const { secret } = await resolveCredentialSecret({
    provider: "merchant",
    connection: input.connection,
    action: input.risk === "read" ? "read" : "write",
  });
  return parseAccessToken(secret);
}

function parseAccessToken(secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) throw new Error("Merchant credential broker returned an empty secret.");
  if (!trimmed.startsWith("{")) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Merchant credential broker returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Merchant credential broker returned a non-object JSON secret.");
  }
  const candidate = parsed as { accessToken?: unknown; access_token?: unknown };
  const token = typeof candidate.accessToken === "string" ? candidate.accessToken : candidate.access_token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Merchant credential broker secret must contain accessToken or access_token.");
  }
  return token;
}

function segment(value: string): string {
  if (!value.trim()) throw new Error("Merchant resource identifier must not be empty.");
  return encodeURIComponent(value.trim());
}

function dataSourceName(accountId: string, dataSourceId: string): string {
  return `accounts/${segment(accountId)}/dataSources/${segment(dataSourceId)}`;
}

function productInputName(accountId: string, productInputId: string): string {
  return `accounts/${segment(accountId)}/productInputs/${segment(productInputId)}`;
}

function listQuery(options: MerchantListOptions): Record<string, string | number | undefined> {
  return { pageSize: options.pageSize, pageToken: options.pageToken };
}

function redact(value: string): string {
  return value
    .replace(/("(?:access_token|refresh_token|client_secret|authorization)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

import type { JsonValue } from "../../cli/return-schemas.js";

export type MlAuthorizationRisk = "read" | "write" | "destructive" | "financial";
export type MlAuthorizationProvider = (input: { connection: string; risk: MlAuthorizationRisk }) => Promise<string>;

export type MlQueryValue = string | number | boolean | undefined;
export type MlQuery = Record<string, MlQueryValue>;
export type MlJsonObject = Record<string, JsonValue>;

export interface MlClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  /** Test seam and future credential-broker adapter. Phase 1 intentionally has no default credential. */
  authorization?: MlAuthorizationProvider;
}

export interface MlListOptions {
  limit?: number;
  offset?: number;
}

export interface MlOrderSearchOptions extends MlListOptions {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: string;
}

export interface MlAdsCampaignOptions extends MlListOptions {
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  metrics?: string;
}

const ML_API = "https://api.mercadolibre.com";

export class MlClient {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #authorization: MlAuthorizationProvider;

  constructor(options: MlClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#authorization = options.authorization ?? phaseOneAuthorization;
  }

  getSeller(): Promise<JsonValue> {
    return this.request("/users/me");
  }

  listItems(sellerId: string, options: MlListOptions & { status?: string; sku?: string } = {}): Promise<JsonValue> {
    return this.request(`/users/${segment(sellerId, "seller id")}/items/search`, {
      query: {
        limit: options.limit,
        offset: options.offset,
        status: options.status,
        seller_sku: options.sku,
      },
    });
  }

  getItem(itemId: string): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}`);
  }

  getItems(itemIds: string[]): Promise<JsonValue> {
    return this.request("/items", { query: { ids: joinedIds(itemIds, "item ids") } });
  }

  getItemDescription(itemId: string): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}/description`);
  }

  getItemVisits(itemId: string, last: number): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}/visits/time_window`, {
      query: { unit: "day", last },
    });
  }

  getItemsVisits(itemIds: string[]): Promise<JsonValue> {
    return this.request("/visits/items", { query: { ids: joinedIds(itemIds, "item ids") } });
  }

  getItemPrices(itemId: string): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}/prices`, { risk: "financial" });
  }

  listOrders(sellerId: string, options: MlOrderSearchOptions = {}): Promise<JsonValue> {
    return this.request("/orders/search", {
      query: {
        seller: sellerId,
        "order.status": options.status,
        "order.date_created.from": options.dateFrom,
        "order.date_created.to": options.dateTo,
        sort: options.sort ?? "date_desc",
        limit: options.limit,
        offset: options.offset,
      },
    });
  }

  getOrder(orderId: string): Promise<JsonValue> {
    return this.request(`/orders/${segment(orderId, "order id")}`);
  }

  async getOrderBillingInfo(orderId: string, siteId: string): Promise<JsonValue> {
    const order = await this.getOrder(orderId);
    const billingInfoId = nestedString(order, ["buyer", "billing_info", "id"]);
    if (!billingInfoId) {
      throw new Error(
        `Order ${orderId} does not expose buyer.billing_info.id. Retry after billing processing or inspect with ravi ml order-get ${orderId} --json.`,
      );
    }
    return this.request(
      `/orders/billing-info/${segment(siteId, "site id")}/${segment(billingInfoId, "billing info id")}`,
      {
        risk: "financial",
      },
    );
  }

  getOrderNotes(orderId: string): Promise<JsonValue> {
    return this.request(`/orders/${segment(orderId, "order id")}/notes`);
  }

  getShipment(shipmentId: string): Promise<JsonValue> {
    return this.request(`/shipments/${segment(shipmentId, "shipment id")}`, { headers: shipmentHeaders() });
  }

  getShipmentCosts(shipmentId: string): Promise<JsonValue> {
    return this.request(`/shipments/${segment(shipmentId, "shipment id")}/costs`, {
      risk: "financial",
      headers: shipmentHeaders(),
    });
  }

  getShipmentHistory(shipmentId: string): Promise<JsonValue> {
    return this.request(`/shipments/${segment(shipmentId, "shipment id")}/history`, {
      headers: shipmentHeaders(),
    });
  }

  listQuestions(sellerId: string, options: MlListOptions & { status?: string } = {}): Promise<JsonValue> {
    return this.request("/questions/search", {
      query: {
        seller_id: sellerId,
        api_version: 4,
        status: options.status,
        limit: options.limit,
        offset: options.offset,
      },
    });
  }

  getPack(packId: string): Promise<JsonValue> {
    return this.request(`/packs/${segment(packId, "pack id")}`);
  }

  getCategory(categoryId: string): Promise<JsonValue> {
    return this.request(`/categories/${segment(categoryId, "category id")}`);
  }

  getTrends(siteId: string, categoryId?: string): Promise<JsonValue> {
    const category = categoryId ? `/${segment(categoryId, "category id")}` : "";
    return this.request(`/trends/${segment(siteId, "site id")}${category}`);
  }

  getHighlights(siteId: string, categoryId: string): Promise<JsonValue> {
    return this.request(`/highlights/${segment(siteId, "site id")}/category/${segment(categoryId, "category id")}`);
  }

  listMessages(packId: string, sellerId: string, options: MlListOptions = {}): Promise<JsonValue> {
    return this.request(`/messages/packs/${segment(packId, "pack id")}/sellers/${segment(sellerId, "seller id")}`, {
      query: { tag: "post_sale", limit: options.limit, offset: options.offset },
    });
  }

  listClaims(sellerId: string, options: MlListOptions & { status?: string; stage?: string } = {}): Promise<JsonValue> {
    return this.request("/post-purchase/v1/claims/search", {
      query: {
        "players.user_id": sellerId,
        "players.role": "respondent",
        status: options.status ?? "opened",
        stage: options.stage,
        limit: options.limit,
        offset: options.offset,
      },
    });
  }

  getClaim(claimId: string): Promise<JsonValue> {
    return this.request(`/post-purchase/v1/claims/${segment(claimId, "claim id")}`);
  }

  getClaimMessages(claimId: string): Promise<JsonValue> {
    return this.request(`/post-purchase/v1/claims/${segment(claimId, "claim id")}/messages`);
  }

  getClaimReturn(claimId: string): Promise<JsonValue> {
    return this.request(`/post-purchase/v2/claims/${segment(claimId, "claim id")}/returns`);
  }

  listAdsAdvertisers(): Promise<JsonValue> {
    return this.request("/advertising/advertisers", {
      risk: "financial",
      query: { product_id: "PADS" },
      headers: { "api-version": "1" },
    });
  }

  listAdsCampaigns(siteId: string, advertiserId: string, options: MlAdsCampaignOptions = {}): Promise<JsonValue> {
    return this.request(
      `/advertising/${segment(siteId, "site id")}/advertisers/${segment(advertiserId, "advertiser id")}/product_ads/campaigns/search`,
      {
        risk: "financial",
        query: {
          limit: options.limit,
          offset: options.offset,
          "filters[status]": options.status,
          date_from: options.dateFrom,
          date_to: options.dateTo,
          metrics: options.metrics,
        },
        headers: { "api-version": "2" },
      },
    );
  }

  listAdsAdGroups(siteId: string, advertiserId: string, itemIds: string[]): Promise<JsonValue> {
    return this.request(
      `/advertising/${segment(siteId, "site id")}/advertisers/${segment(advertiserId, "advertiser id")}/product_ads/ad_groups/search`,
      {
        risk: "financial",
        query: { "filters[item_ids]": joinedIds(itemIds, "item ids") },
        headers: { "api-version": "2" },
      },
    );
  }

  createItem(body: MlJsonObject): Promise<JsonValue> {
    return this.request("/items", { method: "POST", risk: "write", body });
  }

  updateItem(itemId: string, body: MlJsonObject): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}`, { method: "PUT", risk: "write", body });
  }

  createDescription(itemId: string, plainText: string): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}/description`, {
      method: "POST",
      risk: "write",
      body: { plain_text: plainText },
    });
  }

  updateDescription(itemId: string, plainText: string): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}/description`, {
      method: "PUT",
      risk: "write",
      query: { api_version: 2 },
      body: { plain_text: plainText },
    });
  }

  setItemStatus(itemId: string, status: "active" | "paused" | "closed"): Promise<JsonValue> {
    return this.request(`/items/${segment(itemId, "item id")}`, {
      method: "PUT",
      risk: status === "closed" ? "destructive" : "write",
      body: { status },
    });
  }

  async deleteItem(itemId: string): Promise<JsonValue> {
    const closed = await this.request(`/items/${segment(itemId, "item id")}`, {
      method: "PUT",
      risk: "destructive",
      body: { status: "closed" },
    });
    const deleted = await this.request(`/items/${segment(itemId, "item id")}`, {
      method: "PUT",
      risk: "destructive",
      body: { deleted: true },
    });
    return { closed, deleted };
  }

  answerQuestion(questionId: string, text: string): Promise<JsonValue> {
    return this.request("/answers", {
      method: "POST",
      risk: "write",
      body: { question_id: numericId(questionId, "question id"), text },
    });
  }

  sendMessage(packId: string, sellerId: string, toUserId: string, text: string): Promise<JsonValue> {
    return this.request(`/messages/packs/${segment(packId, "pack id")}/sellers/${segment(sellerId, "seller id")}`, {
      method: "POST",
      risk: "write",
      query: { tag: "post_sale" },
      body: {
        from: { user_id: sellerId },
        to: { user_id: toUserId },
        text,
      },
    });
  }

  private async request(
    path: string,
    options: {
      method?: "GET" | "POST" | "PUT";
      risk?: MlAuthorizationRisk;
      query?: MlQuery;
      headers?: Record<string, string>;
      body?: MlJsonObject;
    } = {},
  ): Promise<JsonValue> {
    const risk = options.risk ?? "read";
    const accessToken = await this.#authorization({ connection: this.#connection, risk });
    if (!accessToken.trim()) throw new Error("Mercado Livre authorization provider returned an empty access token.");

    const url = new URL(path, ML_API);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Mercado Livre API request failed (${response.status}): ${redact(text) || response.statusText}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      throw new Error(`Mercado Livre API returned invalid JSON (${response.status}).`);
    }
  }
}

async function phaseOneAuthorization(input: { connection: string; risk: MlAuthorizationRisk }): Promise<string> {
  throw new Error(
    `Mercado Livre authentication is intentionally unavailable in Phase 1 (connection: ${input.connection}, risk: ${input.risk}). ` +
      "Configure a Ravi credential connection in Phase 2; legacy SDE credential files are never read.",
  );
}

function segment(value: string, label: string): string {
  if (!value.trim()) throw new Error(`Mercado Livre ${label} must not be empty.`);
  return encodeURIComponent(value.trim());
}

function numericId(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Mercado Livre ${label} must contain only digits.`);
  return Number(value);
}

function joinedIds(values: string[], label: string): string {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error(`Mercado Livre ${label} must not be empty.`);
  return normalized.join(",");
}

function nestedString(value: JsonValue, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" || typeof current === "number" ? String(current) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shipmentHeaders(): Record<string, string> {
  return { "x-format-new": "true" };
}

function redact(value: string): string {
  return value
    .replace(/("(?:access_token|refresh_token|client_secret|authorization|token)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

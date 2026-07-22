import { describe, expect, it } from "bun:test";
import { MlClient, type MlAuthorizationRisk } from "./client.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function harness(responses: unknown[] = [{}]) {
  const requests: RecordedRequest[] = [];
  const risks: MlAuthorizationRisk[] = [];
  const queue = [...responses];
  const client = new MlClient({
    authorization: async ({ risk }) => {
      risks.push(risk);
      return "test-token-not-a-real-credential";
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify(queue.shift() ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  return { client, requests, risks };
}

describe("Mercado Livre native client", () => {
  it("fails closed before fetch while Phase 1 has no credential provider", async () => {
    let fetchCalls = 0;
    const client = new MlClient({
      fetch: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });

    await expect(client.getSeller()).rejects.toThrow("authentication is intentionally unavailable in Phase 1");
    expect(fetchCalls).toBe(0);
  });

  it("resolves current billing info through buyer.billing_info.id", async () => {
    const { client, requests, risks } = harness([{ buyer: { billing_info: { id: "98765" } } }, { doc_type: "CPF" }]);

    await client.getOrderBillingInfo("2000010733434062", "MLB");

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.mercadolibre.com/orders/2000010733434062",
      "https://api.mercadolibre.com/orders/billing-info/MLB/98765",
    ]);
    expect(risks).toEqual(["read", "financial"]);
  });

  it("uses current shipment and Product Ads headers and paths", async () => {
    const { client, requests, risks } = harness([{}, {}, {}]);

    await client.getShipment("40000123456");
    await client.listAdsCampaigns("MLB", "12345", {
      metrics: "clicks,cost",
      dateFrom: "2026-06-01",
      dateTo: "2026-06-30",
    });
    await client.listAdsAdGroups("MLB", "12345", ["MLB1234567890"]);

    expect(requests[0]?.headers.get("x-format-new")).toBe("true");
    expect(requests[1]?.headers.get("api-version")).toBe("2");
    expect(requests[1]?.url).toContain("/product_ads/campaigns/search?");
    expect(requests[2]?.url).toContain("/product_ads/ad_groups/search?");
    expect(requests.some((request) => request.url.includes("/ads/search"))).toBe(false);
    expect(risks).toEqual(["read", "financial", "financial"]);
  });

  it("classifies reversible, destructive, communication and financial operations separately", async () => {
    const { client, requests, risks } = harness([{}, {}, {}, {}, {}, {}]);

    await client.getItemPrices("MLB1234567890");
    await client.updateItem("MLB1234567890", { available_quantity: 4 });
    await client.setItemStatus("MLB1234567890", "closed");
    await client.answerQuestion("3957150025", "Resposta revisada");
    await client.deleteItem("MLB1234567890");

    expect(risks).toEqual(["financial", "write", "destructive", "write", "destructive", "destructive"]);
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT", "PUT", "POST", "PUT", "PUT"]);
    expect(requests.slice(-2).map((request) => request.body)).toEqual([{ status: "closed" }, { deleted: true }]);
  });

  it("redacts credential-shaped provider error bodies", async () => {
    const client = new MlClient({
      authorization: async () => "local-test-token",
      fetch: (async () =>
        new Response('{"access_token":"provider-secret-value","message":"denied"}', {
          status: 401,
        })) as unknown as typeof fetch,
    });

    let message = "";
    try {
      await client.getSeller();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"access_token":"[redacted]"');
    expect(message).not.toContain("provider-secret-value");
  });
});

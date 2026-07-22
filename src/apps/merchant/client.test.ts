import { describe, expect, it } from "bun:test";
import { MerchantClient } from "./client.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("MerchantClient", () => {
  it("builds the official products v1 list request with fake authorization", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MerchantClient({
      authorization: async () => "unit-test-token",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response({ products: [] });
      },
    });

    await expect(client.listProducts("123", { pageSize: 25, pageToken: "next" })).resolves.toEqual({
      products: [],
    });
    expect(calls[0]?.url).toBe(
      "https://merchantapi.googleapis.com/products/v1/accounts/123/products?pageSize=25&pageToken=next",
    );
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer unit-test-token");
  });

  it("uses distinct risk classes for write, destructive and financial operations", async () => {
    const risks: string[] = [];
    const client = new MerchantClient({
      authorization: async ({ risk }) => {
        risks.push(risk);
        return "unit-test-token";
      },
      fetch: async () => response({}),
    });

    await client.insertProduct("123", "456", { offerId: "sku" });
    await client.deleteProductInput("123", "en~BR~sku", "456");
    await client.createOrderTrackingSignal("123", { orderId: "test-order" });
    expect(risks).toEqual(["write", "destructive", "financial"]);
  });

  it("builds the official productInputs.patch request with explicit data source and field mask", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MerchantClient({
      authorization: async () => "unit-test-token",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response({ name: "accounts/123/productInputs/en~BR~sku" });
      },
    });

    await client.patchProduct("123", "en~BR~sku", "456", "productAttributes.title", {
      productAttributes: { title: "Mock title" },
    });

    expect(calls[0]?.url).toBe(
      "https://merchantapi.googleapis.com/products/v1/accounts/123/productInputs/en~BR~sku?dataSource=accounts%2F123%2FdataSources%2F456&updateMask=productAttributes.title",
    );
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "accounts/123/productInputs/en~BR~sku",
      productAttributes: { title: "Mock title" },
    });
  });

  it("builds the official promotions.insert request with promotion body and data source", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MerchantClient({
      authorization: async () => "unit-test-token",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response({ name: "accounts/123/promotions/promo-1" });
      },
    });

    await client.insertPromotion("123", "456", { promotionId: "promo-1" });

    expect(calls[0]?.url).toBe("https://merchantapi.googleapis.com/promotions/v1/accounts/123/promotions:insert");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      promotion: { promotionId: "promo-1" },
      dataSource: "accounts/123/dataSources/456",
    });
  });

  it("fails closed before network access when Phase 1 has no credential provider", async () => {
    let fetchCalled = false;
    const client = new MerchantClient({
      connection: "missing",
      fetch: async () => {
        fetchCalled = true;
        return response({});
      },
    });

    await expect(client.listAccounts()).rejects.toThrow("Connection not found: merchant:missing");
    expect(fetchCalled).toBe(false);
  });

  it("redacts credential-like API error payloads", async () => {
    const client = new MerchantClient({
      authorization: async () => "unit-test-token",
      fetch: async () => response({ access_token: "should-not-leak", error: "denied" }, 401),
    });

    await expect(client.listAccounts()).rejects.toThrow("[redacted]");
    await expect(client.listAccounts()).rejects.not.toThrow("should-not-leak");
  });
});

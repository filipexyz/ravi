import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CloudflareCustomHostnameError,
  createCloudflareCustomHostnameProvider,
  getCloudflareCustomHostnameConfig,
  isCloudflareCustomHostnameReady,
} from "./cloudflare-custom-hostnames";

type FetchCall = {
  init: RequestInit;
  url: string;
};

function mockFetch(handler: (call: FetchCall) => { body: unknown; status: number }) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = { init: init ?? {}, url: String(url) };
    calls.push(call);
    const { body, status } = handler(call);
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("getCloudflareCustomHostnameConfig", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("returns null when the API token is missing", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(getCloudflareCustomHostnameConfig(process.env)).toBeNull();
  });

  it("uses explicit Pages zone without treating the CNAME target as a custom origin", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tk_abc";
    process.env.RAVI_PAGES_CUSTOM_HOSTNAME_ZONE_ID = "zone_pages";
    process.env.RAVI_PAGES_CUSTOM_HOSTNAME_CNAME_TARGET = "cname.ravi.page";

    expect(getCloudflareCustomHostnameConfig(process.env)).toEqual({
      apiToken: "tk_abc",
      customOriginServer: undefined,
      zoneId: "zone_pages",
      zoneName: "ravi.page",
    });
  });

  it("uses custom origin only when explicitly configured", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tk_abc";
    process.env.RAVI_PAGES_CUSTOM_HOSTNAME_ZONE_ID = "zone_pages";
    process.env.RAVI_PAGES_CUSTOM_HOSTNAME_ORIGIN_SERVER = "proxy-fallback.ravi.page";

    expect(getCloudflareCustomHostnameConfig(process.env)).toEqual({
      apiToken: "tk_abc",
      customOriginServer: "proxy-fallback.ravi.page",
      zoneId: "zone_pages",
      zoneName: "ravi.page",
    });
  });

  it("falls back to CLOUDFLARE_ZONE_ID_RAVI_PAGE", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tk_abc";
    delete process.env.RAVI_PAGES_CUSTOM_HOSTNAME_ZONE_ID;
    process.env.CLOUDFLARE_ZONE_ID_RAVI_PAGE = "zone_ravi_page";

    expect(getCloudflareCustomHostnameConfig(process.env)?.zoneId).toBe("zone_ravi_page");
  });
});

describe("CloudflareCustomHostnameProvider", () => {
  let fetchImpl: typeof fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    ({ calls, fetchImpl } = mockFetch(() => ({ body: { result: {}, success: true }, status: 200 })));
  });

  it("creates a missing custom hostname with HTTP DV and the default fallback origin", async () => {
    ({ calls, fetchImpl } = mockFetch((call) => {
      if (call.init.method === "GET") {
        return { body: { result: [], success: true }, status: 200 };
      }
      return {
        body: {
          result: {
            hostname: "www.customer.example",
            id: "custom_1",
            ssl: { method: "http", status: "pending_validation", type: "dv" },
            status: "pending",
          },
          success: true,
        },
        status: 200,
      };
    }));
    const provider = createCloudflareCustomHostnameProvider({
      apiToken: "tk",
      fetchImpl,
      zoneId: "zone_123",
      zoneName: "ravi.page",
    });

    const result = await provider.ensureCustomHostname({ hostname: "www.customer.example" });

    expect(result.id).toBe("custom_1");
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "POST"]);
    expect(calls[0]!.url).toContain("/zones/zone_123/custom_hostnames?hostname=www.customer.example");
    expect(calls[1]!.url).toContain("/zones/zone_123/custom_hostnames");
    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body).toMatchObject({
      hostname: "www.customer.example",
      ssl: {
        method: "http",
        type: "dv",
      },
    });
    expect(body.custom_origin_server).toBeUndefined();
  });

  it("sends custom origin server only when explicitly configured", async () => {
    ({ calls, fetchImpl } = mockFetch((call) => {
      if (call.init.method === "GET") {
        return { body: { result: [], success: true }, status: 200 };
      }
      return {
        body: {
          result: {
            hostname: "www.customer.example",
            id: "custom_1",
            ssl: { method: "http", status: "pending_validation", type: "dv" },
            status: "pending",
          },
          success: true,
        },
        status: 200,
      };
    }));
    const provider = createCloudflareCustomHostnameProvider({
      apiToken: "tk",
      customOriginServer: "proxy-fallback.ravi.page",
      fetchImpl,
      zoneId: "zone_123",
      zoneName: "ravi.page",
    });

    await provider.ensureCustomHostname({ hostname: "www.customer.example" });

    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body.custom_origin_server).toBe("proxy-fallback.ravi.page");
  });

  it("creates wildcard custom hostnames with TXT DCV and wildcard SSL enabled", async () => {
    ({ calls, fetchImpl } = mockFetch((call) => {
      if (call.init.method === "GET") {
        return { body: { result: [], success: true }, status: 200 };
      }
      return {
        body: {
          result: {
            hostname: "*.customer.example",
            id: "custom_wildcard",
            ssl: { method: "txt", status: "pending_validation", type: "dv", wildcard: true },
            status: "pending",
          },
          success: true,
        },
        status: 200,
      };
    }));
    const provider = createCloudflareCustomHostnameProvider({
      apiToken: "tk",
      fetchImpl,
      zoneId: "zone_123",
      zoneName: "ravi.page",
    });

    await provider.ensureCustomHostname({ hostname: "*.customer.example" });

    const body = JSON.parse(calls[1]!.init.body as string);
    expect(body.ssl).toMatchObject({
      method: "txt",
      type: "dv",
      wildcard: true,
    });
  });


  it("refreshes an existing pending hostname so HTTP DCV can retry after DNS changes", async () => {
    ({ calls, fetchImpl } = mockFetch((call) => {
      if (call.init.method === "GET") {
        return {
          body: {
            result: [
              {
                hostname: "www.customer.example",
                id: "custom_1",
                ssl: { status: "pending_validation" },
                status: "pending",
              },
            ],
            success: true,
          },
          status: 200,
        };
      }
      return {
        body: {
          result: {
            hostname: "www.customer.example",
            id: "custom_1",
            ssl: { status: "pending_validation" },
            status: "pending",
          },
          success: true,
        },
        status: 200,
      };
    }));
    const provider = createCloudflareCustomHostnameProvider({
      apiToken: "tk",
      fetchImpl,
      zoneId: "zone_123",
      zoneName: "ravi.page",
    });

    await provider.ensureCustomHostname({ hostname: "www.customer.example" });

    expect(calls.map((call) => call.init.method)).toEqual(["GET", "PATCH"]);
    expect(calls[1]!.url).toContain("/zones/zone_123/custom_hostnames/custom_1");
  });

  it("does not patch an active hostname", async () => {
    ({ calls, fetchImpl } = mockFetch(() => ({
      body: {
        result: [
          {
            hostname: "www.customer.example",
            id: "custom_1",
            ssl: { status: "active" },
            status: "active",
          },
        ],
        success: true,
      },
      status: 200,
    })));
    const provider = createCloudflareCustomHostnameProvider({
      apiToken: "tk",
      fetchImpl,
      zoneId: "zone_123",
      zoneName: "ravi.page",
    });

    const result = await provider.ensureCustomHostname({ hostname: "www.customer.example" });

    expect(isCloudflareCustomHostnameReady(result)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("maps Cloudflare errors to provider errors", async () => {
    ({ fetchImpl } = mockFetch(() => ({
      body: { errors: [{ code: 10000, message: "Authentication error" }], success: false },
      status: 403,
    })));
    const provider = createCloudflareCustomHostnameProvider({
      apiToken: "tk",
      fetchImpl,
      zoneId: "zone_123",
      zoneName: "ravi.page",
    });

    await expect(provider.ensureCustomHostname({ hostname: "www.customer.example" })).rejects.toBeInstanceOf(
      CloudflareCustomHostnameError,
    );
  });
});

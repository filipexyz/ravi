import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CloudflareEmailRoutingError,
  createCloudflareEmailRoutingProvider,
  getCloudflareEmailRoutingConfig,
} from "./cloudflare-email-routing";

type FetchCall = {
  url: string;
  init: RequestInit;
};

function mockFetch(handler: (call: FetchCall) => { status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("getCloudflareEmailRoutingConfig", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("returns null when CLOUDFLARE_API_TOKEN is missing", () => {
    delete process.env.CLOUDFLARE_API_TOKEN;
    expect(getCloudflareEmailRoutingConfig(process.env)).toBeNull();
  });

  it("returns config with default worker name when only token is set", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tk_abc";
    delete process.env.RAVI_MAIL_WORKER_NAME;
    expect(getCloudflareEmailRoutingConfig(process.env)).toEqual({
      apiToken: "tk_abc",
      workerName: "ravi-mail",
    });
  });

  it("honors RAVI_MAIL_WORKER_NAME override", () => {
    process.env.CLOUDFLARE_API_TOKEN = "tk_abc";
    process.env.RAVI_MAIL_WORKER_NAME = "custom-worker";
    expect(getCloudflareEmailRoutingConfig(process.env)).toEqual({
      apiToken: "tk_abc",
      workerName: "custom-worker",
    });
  });
});

describe("CloudflareEmailRoutingProvider", () => {
  let fetchImpl: typeof fetch;
  let calls: FetchCall[];

  beforeEach(() => {
    ({ fetchImpl, calls } = mockFetch(() => ({ status: 200, body: { success: true, result: {} } })));
  });

  it("lookupZoneIdByName returns the matching zone id", async () => {
    ({ fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: {
        success: true,
        result: [
          { id: "zone_123", name: "ravi.bot" },
          { id: "zone_999", name: "other.example" },
        ],
      },
    })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });
    const id = await provider.lookupZoneIdByName("ravi.bot");
    expect(id).toBe("zone_123");
    expect(calls[0]!.url).toContain("/zones?name=ravi.bot");
  });

  it("lookupZoneIdByName returns null when no zone matches", async () => {
    ({ fetchImpl } = mockFetch(() => ({ status: 200, body: { success: true, result: [] } })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });
    expect(await provider.lookupZoneIdByName("missing.example")).toBeNull();
  });

  it("createAddressRule POSTs with worker action and returns the rule", async () => {
    ({ fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: {
        success: true,
        result: {
          id: "rule_1",
          name: "ravi-mail:luis@ravi.bot",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "luis@ravi.bot" }],
          actions: [{ type: "worker", value: ["ravi-mail"] }],
        },
      },
    })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });
    const rule = await provider.createAddressRule({ zoneId: "zone_123", address: "luis@ravi.bot" });
    expect(rule.id).toBe("rule_1");
    const call = calls[0]!;
    expect(call.url).toContain("/zones/zone_123/email/routing/rules");
    expect(call.init.method).toBe("POST");
    const body = JSON.parse(call.init.body as string);
    expect(body.matchers[0]).toEqual({ type: "literal", field: "to", value: "luis@ravi.bot" });
    expect(body.actions[0]).toEqual({ type: "worker", value: ["ravi-mail"] });
    expect(body.enabled).toBe(true);
  });

  it("deleteAddressRule issues DELETE to the rule path", async () => {
    ({ fetchImpl, calls } = mockFetch(() => ({ status: 200, body: { success: true, result: { id: "rule_1" } } })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });
    await provider.deleteAddressRule({ zoneId: "zone_123", ruleId: "rule_1" });
    expect(calls[0]!.url).toContain("/zones/zone_123/email/routing/rules/rule_1");
    expect(calls[0]!.init.method).toBe("DELETE");
  });

  it("deleteAddressRulesByAddress deletes every literal rule for the address", async () => {
    ({ fetchImpl, calls } = mockFetch((call) => {
      if (call.init.method === "GET") {
        return {
          status: 200,
          body: {
            success: true,
            result: [
              {
                id: "rule_1",
                name: "ravi-mail:teste@ravi.bot",
                enabled: true,
                matchers: [{ type: "literal", field: "to", value: "teste@ravi.bot" }],
                actions: [{ type: "worker", value: ["ravi-mail"] }],
              },
              {
                id: "rule_2",
                name: "ravi-mail:other@ravi.bot",
                enabled: true,
                matchers: [{ type: "literal", field: "to", value: "other@ravi.bot" }],
                actions: [{ type: "worker", value: ["ravi-mail"] }],
              },
              {
                id: "rule_3",
                name: "ravi-mail:duplicate",
                enabled: true,
                matchers: [{ type: "literal", field: "to", value: "Teste@Ravi.Bot" }],
                actions: [{ type: "worker", value: ["ravi-mail"] }],
              },
            ],
          },
        };
      }
      return { status: 200, body: { success: true, result: { id: "deleted" } } };
    }));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });

    const result = await provider.deleteAddressRulesByAddress({ zoneId: "zone_123", address: "teste@ravi.bot" });

    expect(result.deletedRuleIds).toEqual(["rule_1", "rule_3"]);
    expect(calls.map((call) => call.init.method)).toEqual(["GET", "DELETE", "DELETE"]);
    expect(calls[1]!.url).toContain("/zones/zone_123/email/routing/rules/rule_1");
    expect(calls[2]!.url).toContain("/zones/zone_123/email/routing/rules/rule_3");
  });

  it("deleteAddressRulesByAddress is a no-op when no rule matches", async () => {
    ({ fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: {
        success: true,
        result: [
          {
            id: "rule_1",
            name: "ravi-mail:other@ravi.bot",
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: "other@ravi.bot" }],
            actions: [{ type: "worker", value: ["ravi-mail"] }],
          },
        ],
      },
    })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });

    const result = await provider.deleteAddressRulesByAddress({ zoneId: "zone_123", address: "missing@ravi.bot" });

    expect(result.deletedRuleIds).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("maps Cloudflare error envelope to CloudflareEmailRoutingError", async () => {
    ({ fetchImpl } = mockFetch(() => ({
      status: 403,
      body: {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      },
    })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });
    await expect(provider.createAddressRule({ zoneId: "zone_123", address: "x@y" })).rejects.toMatchObject({
      name: "CloudflareEmailRoutingError",
      code: "CF_10000",
      status: 403,
    });
  });

  it("falls back to status-based code when no errors envelope is returned", async () => {
    ({ fetchImpl } = mockFetch(() => ({ status: 429, body: { success: false } })));
    const provider = createCloudflareEmailRoutingProvider({
      apiToken: "tk",
      workerName: "ravi-mail",
      fetchImpl,
    });
    try {
      await provider.createAddressRule({ zoneId: "zone_123", address: "x@y" });
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareEmailRoutingError);
      expect((error as CloudflareEmailRoutingError).code).toBe("CF_RATE_LIMITED");
    }
  });
});

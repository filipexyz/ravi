import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const actualCliContextModule = await import("../context.js");

mock.module("../context.js", () => ({
  ...actualCliContextModule,
  // Contract helpers throw ContractError instead of exiting when a context exists.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

const { RuntimeModelCatalogCommands } = await import("./runtime-models.js");
const { ContractError } = await import("../agent-contract.js");
const { runtimeModelCatalogListReturnSchema } = await import("./operational-return-schemas.js");
const { listRegisteredRuntimeProviderIds } = await import("../../runtime/provider-registry.js");

let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

describe("runtime models CLI", () => {
  it("lists every registered provider, including pi, under the strict return schema", () => {
    const payload = new RuntimeModelCatalogCommands().list(undefined, true);

    expect(runtimeModelCatalogListReturnSchema.parse(payload)).toEqual(payload);
    expect(payload.providers.map((provider) => provider.id)).toEqual(listRegisteredRuntimeProviderIds());
    expect(payload.providers.map((provider) => provider.id)).toContain("pi");
    expect(payload.total).toBe(payload.providers.length);
    expect(payload.pagination.hasMore).toBe(false);
    const claude = payload.providers.find((provider) => provider.id === "claude");
    expect(claude?.models.map((model) => model.id)).toEqual(["sonnet", "haiku", "opus"]);
    expect(claude?.defaultModel).toBe("sonnet");
  });

  it("filters to one provider", () => {
    const payload = new RuntimeModelCatalogCommands().list("grok", true);

    expect(payload.total).toBe(1);
    expect(payload.providers[0]).toMatchObject({ id: "grok", freeText: false, defaultModel: "grok-4" });
  });

  it("pages providers with offset pagination metadata", () => {
    const registered = listRegisteredRuntimeProviderIds();
    const payload = new RuntimeModelCatalogCommands().list(undefined, true, "1", "1");

    expect(payload.providers.map((provider) => provider.id)).toEqual(registered.slice(1, 2));
    expect(payload.total).toBe(registered.length);
    expect(payload.pagination).toMatchObject({ limit: 1, offset: 1, returned: 1, total: registered.length });
  });

  it("rejects an unregistered provider with suggestions", () => {
    let error: unknown;
    try {
      new RuntimeModelCatalogCommands().list("codx", true);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ContractError);
    expect((error as InstanceType<typeof ContractError>).code).toBe("PROVIDER_NOT_FOUND");
  });
});

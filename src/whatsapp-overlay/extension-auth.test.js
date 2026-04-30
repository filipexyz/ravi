import { beforeEach, describe, expect, it } from "bun:test";

function installChromeStorageMock() {
  const store = new Map();
  globalThis.chrome = {
    storage: {
      local: {
        get(key, callback) {
          const result = {};
          const keys = Array.isArray(key) ? key : [key];
          for (const item of keys) {
            if (typeof item === "string" && store.has(item)) {
              result[item] = store.get(item);
            }
          }
          if (typeof callback === "function") {
            callback(result);
            return undefined;
          }
          return Promise.resolve(result);
        },
        set(items, callback) {
          for (const [key, value] of Object.entries(items ?? {})) {
            store.set(key, value);
          }
          if (typeof callback === "function") {
            callback();
            return undefined;
          }
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener() {},
        removeListener() {},
      },
    },
  };
  return store;
}

const chromeStorage = installChromeStorageMock();

const { addServer, isValidContextKey, testConnection } = await import("../../extensions/whatsapp-overlay/auth.js");

describe("whatsapp overlay auth", () => {
  beforeEach(() => {
    chromeStorage.clear();
  });

  it("requires runtime context keys instead of context ids", async () => {
    expect(isValidContextKey("rctx_abc")).toBe(true);
    expect(isValidContextKey("ctx_abc")).toBe(false);

    await expect(
      addServer({
        name: "local",
        baseUrl: "http://127.0.0.1:4211/",
        contextKey: "ctx_abc",
      }),
    ).rejects.toThrow("rctx_*");
  });

  it("surfaces invalid stored keys before calling the gateway", async () => {
    chromeStorage.set("ravi_auth", {
      servers: [
        {
          id: "srv_local",
          name: "local",
          baseUrl: "http://127.0.0.1:4211",
          contextKey: "ctx_abc",
          addedAt: Date.now(),
        },
      ],
      activeId: "srv_local",
    });

    const result = await testConnection();

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      code: "invalid_context_key",
    });
  });
});

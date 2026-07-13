import { describe, expect, it } from "bun:test";

import {
  createInheritedClient,
  resolveInheritedBaseUrl,
  resolveInheritedContextKey,
} from "../inherit.js";

describe("createInheritedClient", () => {
  it("uses the current runtime context by default", async () => {
    const seen: Array<{ url: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        auth: headers.get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return jsonResponse({
        kind: "turn-runtime",
        agentId: "ravi-workflows",
        sessionName: "ravi-workflows",
        capabilitiesCount: 23,
      });
    };

    const inherited = await createInheritedClient({
      env: {
        RAVI_BASE_URL: "http://ravi.test/",
        RAVI_CONTEXT_KEY: "rctx_parent",
      },
      fetch: fetchImpl,
    });
    const me = await inherited.client.context.whoami();

    expect(inherited.mode).toBe("current");
    expect(inherited.baseUrl).toBe("http://ravi.test");
    expect(inherited.contextId).toBeUndefined();
    expect(inherited.revoke).toBeUndefined();
    expect(me.sessionName).toBe("ravi-workflows");
    expect(seen).toEqual([
      {
        url: "http://ravi.test/api/v1/context/whoami",
        auth: "Bearer rctx_parent",
        body: {},
      },
    ]);
  });

  it("can issue, use, and revoke an explicit child context", async () => {
    const seen: Array<{ path: string; auth: string | null; body: unknown }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      seen.push({ path: url.pathname, auth: headers.get("authorization"), body });

      if (url.pathname === "/api/v1/context/issue") {
        return jsonResponse({
          contextId: "ctx_child",
          contextKey: "rctx_child",
          kind: "cli-runtime",
          capabilitiesCount: 23,
        });
      }
      if (url.pathname === "/api/v1/context/whoami") {
        return jsonResponse({
          kind: "cli-runtime",
          issuedFor: "sdk-inherit-test",
          sessionName: "ravi-workflows",
          capabilitiesCount: 23,
        });
      }
      if (url.pathname === "/api/v1/context/revoke") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "unexpected" }, 404);
    };

    const inherited = await createInheritedClient({
      env: {
        RAVI_HTTP_HOST: "127.0.0.1",
        RAVI_HTTP_PORT: "4211",
        RAVI_CONTEXT_KEY: "rctx_parent",
      },
      child: {
        cliName: "sdk-inherit-test",
        ttl: "2m",
        inherit: true,
      },
      fetch: fetchImpl,
    });
    const me = await inherited.client.context.whoami();
    await inherited.revoke?.("done");

    expect(inherited.mode).toBe("child");
    expect(inherited.baseUrl).toBe("http://127.0.0.1:4211");
    expect(inherited.contextId).toBe("ctx_child");
    expect(me.issuedFor).toBe("sdk-inherit-test");
    expect(seen).toEqual([
      {
        path: "/api/v1/context/issue",
        auth: "Bearer rctx_parent",
        body: { cliName: "sdk-inherit-test", inherit: true, ttl: "2m" },
      },
      {
        path: "/api/v1/context/whoami",
        auth: "Bearer rctx_child",
        body: {},
      },
      {
        path: "/api/v1/context/revoke",
        auth: "Bearer rctx_parent",
        body: { contextId: "ctx_child", reason: "done" },
      },
    ]);
  });

  it("requires explicit child inheritance or allowed capabilities", async () => {
    await expect(
      createInheritedClient({
        env: {
          RAVI_BASE_URL: "http://ravi.test",
          RAVI_CONTEXT_KEY: "rctx_parent",
        },
        child: { cliName: "sdk-inherit-test" },
        fetch: async () => jsonResponse({}),
      }),
    ).rejects.toThrow("child mode requires child.inherit === true or a non-empty child.allow");
  });
});

describe("inherit env resolution", () => {
  it("derives base URL and context key from Ravi env", () => {
    expect(resolveInheritedBaseUrl({ RAVI_HTTP_PORT: "4211" })).toBe("http://127.0.0.1:4211");
    expect(resolveInheritedBaseUrl({ RAVI_HTTP_HOST: "0.0.0.0", RAVI_HTTP_PORT: "4211" })).toBe(
      "http://127.0.0.1:4211",
    );
    expect(resolveInheritedContextKey({ RAVI_CONTEXT_KEY: " rctx_parent " })).toBe("rctx_parent");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

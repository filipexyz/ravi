import { afterEach, describe, expect, test } from "bun:test";
import { serve } from "bun";
import { bindClaudeModelCalls } from "./claude-model-call-binding.js";
import type { ModelCallInvalidation } from "./model-call-fence.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function nativeSettingsControl(initial: Record<string, string>) {
  let env = initial;
  return {
    async getSettings() {
      return { effective: { env }, sources: {}, applied: {} };
    },
    async applyFlagSettings(settings: { env: Record<string, string> }) {
      env = { ...settings.env };
    },
    environment() {
      return env;
    },
  };
}

const binding = {
  snapshotId: "snapshot-http-1",
  scope: { agentId: "restricted", executionId: "execution-1", contextKey: "rctx_fixture_private" },
};

describe("Claude model call binding", () => {
  test("checks actual model bytes before forwarding through the native binding", async () => {
    let upstreamCalls = 0;
    let inspections = 0;
    let invalidations = 0;
    const upstream = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        upstreamCalls++;
        return new Response("ok");
      },
    });
    cleanup.push(() => upstream.stop(true));
    const query = nativeSettingsControl({ ANTHROPIC_BASE_URL: upstream.url.origin });
    const guarded = await bindClaudeModelCalls({
      query,
      binding,
      environment: {},
      assertCurrent() {},
      notifyInvalidated() {
        invalidations++;
      },
      beforeDispatch(request) {
        inspections++;
        expect(request.path).toBe("/v1/messages");
        expect(new TextDecoder().decode(request.body)).toBe("unauthorized fixture");
        throw new Error("Fixture catalogue mismatch");
      },
    });
    cleanup.push(() => guarded.close());
    const response = await fetch(`${query.environment().ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      body: "unauthorized fixture",
    });
    expect(response.status).toBe(409);
    expect(inspections).toBe(1);
    expect(invalidations).toBe(1);
    expect(upstreamCalls).toBe(0);
  });

  test("pins the native effective route and checks every request and retry after revocation", async () => {
    let upstreamCalls = 0;
    let bypassCalls = 0;
    const upstream = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        upstreamCalls++;
        return new Response("ok");
      },
    });
    const bypass = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        bypassCalls++;
        return new Response("bad");
      },
    });
    cleanup.push(
      () => upstream.stop(true),
      () => bypass.stop(true),
    );
    const query = nativeSettingsControl({ ANTHROPIC_BASE_URL: upstream.url.origin, RETAIN_SETTING: "fixture" });
    let current = true;
    const notifications: ModelCallInvalidation[] = [];
    const guarded = await bindClaudeModelCalls({
      query,
      binding,
      environment: { ANTHROPIC_BASE_URL: bypass.url.origin },
      assertCurrent() {
        if (!current) throw new Error("Fixture changed");
      },
      notifyInvalidated(event) {
        notifications.push(event);
        current = true;
      },
    });
    cleanup.push(() => guarded.close());
    const base = query.environment().ANTHROPIC_BASE_URL;
    expect(base.startsWith("http://127.0.0.1:")).toBe(true);
    expect(base.includes("/model-call/")).toBe(true);
    expect(query.environment().RETAIN_SETTING).toBe("fixture");
    expect(query.environment().CLAUDE_CODE_USE_BEDROCK).toBe("0");
    expect(query.environment().CLAUDE_CODE_USE_VERTEX).toBe("0");
    expect(query.environment().CLAUDE_CODE_USE_FOUNDRY).toBe("0");
    expect((await fetch(`${base}/v1/messages?beta=true`, { method: "POST", body: "fixture" })).status).toBe(200);
    current = false;
    expect((await fetch(`${base}/v1/messages`, { method: "POST", body: "fixture" })).status).toBe(409);
    expect((await fetch(`${base}/v1/messages`, { method: "POST", body: "fixture retry" })).status).toBe(409);
    expect(upstreamCalls).toBe(1);
    expect(bypassCalls).toBe(0);
    expect(notifications.length).toBe(1);
    expect(JSON.stringify(notifications).includes("rctx_fixture_private")).toBe(false);
  });

  test("includes token counting in the same guard and closes the listener", async () => {
    let checks = 0;
    const paths: string[] = [];
    const upstream = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return new Response("ok");
      },
    });
    cleanup.push(() => upstream.stop(true));
    const query = nativeSettingsControl({ ANTHROPIC_BASE_URL: `${upstream.url.origin}/bound` });
    const guarded = await bindClaudeModelCalls({
      query,
      binding,
      environment: {},
      assertCurrent() {
        checks++;
      },
      notifyInvalidated() {},
    });
    cleanup.push(() => guarded.close());
    const base = query.environment().ANTHROPIC_BASE_URL;
    await (await fetch(`${base}/v1/messages/count_tokens?beta=true`, { method: "POST", body: "fixture" })).text();
    expect(paths).toEqual(["/bound/v1/messages/count_tokens"]);
    expect(checks).toBe(1);
    await guarded.close();
    await expect(fetch(`${base}/v1/messages`, { method: "POST" })).rejects.toThrow();
  });

  test("refuses a native runtime that cannot prove its endpoint was pinned", async () => {
    const query = {
      async getSettings() {
        return { effective: { env: { ANTHROPIC_BASE_URL: "https://fixture.invalid" } }, sources: {}, applied: {} };
      },
      async applyFlagSettings() {},
    };
    await expect(
      bindClaudeModelCalls({ query, binding, environment: {}, assertCurrent() {}, notifyInvalidated() {} }),
    ).rejects.toThrow("pin");
  });

  test("refuses alternate cloud transports outside the declared HTTP boundary", async () => {
    const query = nativeSettingsControl({ CLAUDE_CODE_USE_BEDROCK: "1" });
    await expect(
      bindClaudeModelCalls({ query, binding, environment: {}, assertCurrent() {}, notifyInvalidated() {} }),
    ).rejects.toThrow("transport");
  });
});

import { describe, expect, test } from "bun:test";
import { buildCodexProtectedModelConfig, resolveCodexProtectedModelRoute } from "./codex-skill-model-route.js";

describe("Codex protected model route", () => {
  test("uses the native account mode only to choose the proven default Responses base", () => {
    const chatgpt = resolveCodexProtectedModelRoute(
      { config: { model_provider: "openai" } },
      { account: { type: "chatgpt" } },
    );
    expect(chatgpt.upstreamBaseUrl).toBe("https://chatgpt.com/backend-api/codex");
    const api = resolveCodexProtectedModelRoute({ config: { model_provider: null } }, { account: { type: "apiKey" } });
    expect(api.upstreamBaseUrl).toBe("https://api.openai.com/v1");
    const overridden = resolveCodexProtectedModelRoute(
      { config: { openai_base_url: "http://127.0.0.1:3456/native" } },
      { account: { type: "chatgpt" } },
    );
    expect(overridden.upstreamBaseUrl).toBe("http://127.0.0.1:3456/native");
    expect(overridden.providerOptions).toEqual({ name: "OpenAI", requires_openai_auth: true, wire_api: "responses" });
  });

  test("keeps the configured fixed Responses destination and native authentication contract", () => {
    const route = resolveCodexProtectedModelRoute(
      {
        config: {
          model_provider: "fixture",
          model_providers: {
            fixture: {
              name: "Fixture",
              base_url: "http://127.0.0.1:3456/v1",
              wire_api: "responses",
              requires_openai_auth: false,
              env_key: "FIXTURE_API_KEY",
            },
          },
        },
      },
      { account: null },
      {},
    );
    expect(route.upstreamBaseUrl).toBe("http://127.0.0.1:3456/v1");
    const config = buildCodexProtectedModelConfig(route, "http://127.0.0.1:9876/model-call/fixture", [
      { path: "/fixture/denied/SKILL.md", enabled: false },
    ]);
    expect(config["model_providers.ravi_skill_fence.base_url"]).toBe("http://127.0.0.1:9876/model-call/fixture");
    expect(config["model_providers.ravi_skill_fence.env_key"]).toBe("FIXTURE_API_KEY");
    expect(config["model_providers.ravi_skill_fence.requires_openai_auth"]).toBe(false);
    expect(config["model_providers.ravi_skill_fence.supports_websockets"]).toBe(false);
    expect(config["skills.config"]).toEqual([{ path: "/fixture/denied/SKILL.md", enabled: false }]);
    expect(config["features.enable_request_compression"]).toBe(false);
  });

  test("does not permit native children to discover a new unbound catalog", () => {
    const route = resolveCodexProtectedModelRoute(
      {
        config: {
          model_provider: "fixture",
          model_providers: { fixture: { base_url: "http://127.0.0.1:3456/v1", wire_api: "responses" } },
        },
      },
      { account: null },
      {},
    );
    const config = buildCodexProtectedModelConfig(route, "http://127.0.0.1:9876/fence", []);
    expect(config["features.multi_agent"]).toBe(false);
    expect(config["features.multi_agent_v2"]).toBe(false);
    expect(config["features.remote_plugin"]).toBe(false);
    expect(config["agents.enabled"]).toBe(false);
  });

  test("omits null config/read defaults which cannot be converted to TOML overrides", () => {
    const route = resolveCodexProtectedModelRoute(
      {
        config: {
          model_provider: "fixture",
          model_providers: {
            fixture: {
              base_url: "http://127.0.0.1:3456/v1",
              env_key: null,
              http_headers: null,
              env_http_headers: null,
            },
          },
        },
      },
      { account: null },
    );
    const config = buildCodexProtectedModelConfig(route, "http://127.0.0.1:9876/fence", []);
    expect(Object.values(config)).not.toContain(null);
  });

  test("rejects malformed, credentialed URL and unsupported wire transports without echoing values", () => {
    for (const fixture of [
      { base_url: "http://fixture:dummy-private@127.0.0.1:3456/v1", wire_api: "responses" },
      { base_url: "http://127.0.0.1:3456/v1", wire_api: "chat" },
      { base_url: "http://127.0.0.1:3456/v1?dummy-private=secret", wire_api: "responses" },
      { base_url: "http://127.0.0.1:3456/v1", wire_api: "responses", query_params: { "api-version": "fixture" } },
    ]) {
      expect(() =>
        resolveCodexProtectedModelRoute(
          { config: { model_provider: "fixture", model_providers: { fixture } } },
          { account: null },
          {},
        ),
      ).toThrow("unsupported");
    }
  });
});

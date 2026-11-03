import { describe, expect, test } from "bun:test";
import { pageChatModelTransport } from "./model-provider";

const actor = { user: "hashed-speaker", tags: ["pages_chat"] };
describe("Page chat model transport", () => {
  test("retains explicit gateway transport for the hosted product", () => {
    expect(pageChatModelTransport("vendor/model", actor, {})).toEqual({
      model: "vendor/model", providerOptions: { gateway: actor },
    });
  });
  test("direct DeepSeek has no Gateway options", () => {
    const result = pageChatModelTransport("deepseek/deepseek-chat", actor, {
      PAGE_CHAT_MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-test-not-a-key",
    });
    expect(result.providerOptions).toBeUndefined();
    expect(typeof result.model).not.toBe("string");
    expect((result.model as { provider: string }).provider).toContain("deepseek");
  });
  test("never silently changes a configured provider/model or leaks credentials", () => {
    expect(() => pageChatModelTransport("deepseek/deepseek-chat", actor, { PAGE_CHAT_MODEL_PROVIDER: "invalid" })).toThrow("page_chat_model_provider_invalid");
    expect(() => pageChatModelTransport("deepseek/deepseek-chat", actor, { PAGE_CHAT_MODEL_PROVIDER: "deepseek" })).toThrow("page_chat_model_credential_missing");
    expect(() => pageChatModelTransport("vendor/model", actor, { PAGE_CHAT_MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "synthetic-test-not-a-key" })).toThrow("page_chat_model_provider_mismatch");
  });
});

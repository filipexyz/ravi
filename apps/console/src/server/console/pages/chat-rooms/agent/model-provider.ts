import { createDeepSeek } from "@ai-sdk/deepseek";
import { pageChatEngineEnabled } from "../../chat/engine";

/** Select transport explicitly. A self-host deployment must never fall back to Gateway. */
export function pageChatModelTransport(
  model: string,
  actor: { user: string; tags: string[] },
  env: Record<string, string | undefined> = process.env,
) {
  if (!pageChatEngineEnabled(env)) throw new Error("page_chat_engine_disabled");
  const provider = env.PAGE_CHAT_MODEL_PROVIDER?.trim() || "gateway";
  if (provider === "gateway") {
    return { model, providerOptions: { gateway: actor } };
  }
  if (provider !== "deepseek") throw new Error("page_chat_model_provider_invalid");
  if (!env.DEEPSEEK_API_KEY?.trim()) throw new Error("page_chat_model_credential_missing");
  const match = /^deepseek\/([a-z0-9][a-z0-9.:-]{0,80})$/.exec(model);
  if (!match?.[1]) throw new Error("page_chat_model_provider_mismatch");
  return {
    model: createDeepSeek({ apiKey: env.DEEPSEEK_API_KEY })(match[1]),
    providerOptions: undefined,
  };
}

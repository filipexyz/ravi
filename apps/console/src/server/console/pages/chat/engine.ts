import { ConsoleApiError } from "@/server/console/api-error";

/** Installation capability, never overridden by an entitlement or Page metadata. */
export function pageChatEngineEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RAVI_PAGES_AI_ENABLED === undefined
    ? env.RAVI_AUTH_MODE !== "oidc"
    : env.RAVI_PAGES_AI_ENABLED === "1";
}

export function requirePageChatEngine() {
  if (!pageChatEngineEnabled()) throw new ConsoleApiError(503, { error: "page_chat_engine_disabled" });
}

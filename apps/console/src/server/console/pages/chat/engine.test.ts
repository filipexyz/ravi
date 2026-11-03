import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pageChatEngineEnabled } from "./engine";
import { resolveConsoleFeatureAccess } from "../../feature-access";
import { authorizePageChatSession } from "./session";
import { updatePageChatSettingsFromCli } from "./cli";
import { openChatRoom, sendChatMessage, decideChatConfirmation, mirrorPageCommentIntoRoom } from "../chat-rooms/service";
import { handleChatRoomRequest } from "../chat-rooms/http";
import { beginTurn, runModelRound, runToolCall, requestConfirmation, applyConfirmation, askRavi, checkRaviReply, postRaviFollowUp, finishTurn } from "../chat-rooms/agent/turn";
import { startPageChatTurn, startRaviFollowUp, resumePageChatConfirmation } from "../chat-rooms/agent/runner";
import { pageChatModelTransport } from "../chat-rooms/agent/model-provider";
import { POST as voice } from "@/app/api/internal/pages/chat/session/route";
import { POST as closeVoice } from "@/app/api/internal/pages/chat/close/route";

const originalFlag = process.env.RAVI_PAGES_AI_ENABLED;
const originalFetch = globalThis.fetch;
let touched = 0;
const forbidden = new Proxy({}, { get() { touched++; throw new Error("forbidden_dependency_access"); } }) as any;
beforeEach(() => {
  touched = 0;
  process.env.RAVI_PAGES_AI_ENABLED = "0";
  globalThis.fetch = (() => { touched++; throw new Error("forbidden_network"); }) as any;
});
afterEach(() => {
  if (originalFlag === undefined) delete process.env.RAVI_PAGES_AI_ENABLED;
  else process.env.RAVI_PAGES_AI_ENABLED = originalFlag;
  globalThis.fetch = originalFetch;
  expect(touched).toBe(0);
});

describe("installation excludes Pages AI without provider, store, dispatch or effects", () => {
  test("OIDC defaults off, explicit values fail closed, cloud default unchanged", () => {
    expect(pageChatEngineEnabled({ RAVI_AUTH_MODE: "oidc" })).toBe(false);
    expect(pageChatEngineEnabled({})).toBe(true);
    for (const flag of ["0", "false", "true", "", "garbage"]) expect(pageChatEngineEnabled({ RAVI_PAGES_AI_ENABLED: flag })).toBe(false);
    expect(pageChatEngineEnabled({ RAVI_AUTH_MODE: "oidc", RAVI_PAGES_AI_ENABLED: "1" })).toBe(true);
  });
  test("entitlement cannot activate or advertise the excluded engine; core features remain", () => {
    const access = resolveConsoleFeatureAccess({ organizationId: "org", plan: "free", role: "owner", entitlements: [{ key: "console.pages.chat", valueJson: { enabled: true } }] });
    expect(access.byKey["console.pages.chat"]).toMatchObject({ enabled: false, available: false, visible: false, requestable: false });
    expect(access.byKey["console.pages"].enabled).toBe(true);
    expect(access.byKey["console.bases"].enabled).toBe(true);
  });
  test("direct internal requests refuse before handler/control/provider", async () => {
    const req = () => new Request("https://console.test/api/internal/pages/chat/session", { method: "POST", body: "invalid" });
    for (const response of [await handleChatRoomRequest(req(), async () => forbidden.handler()), await voice(req()), await closeVoice(req())]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "page_chat_engine_disabled" });
    }
  });
  test("admission and site metadata change cannot bypass installation policy", async () => {
    for (const action of [
      () => openChatRoom({}, "request", forbidden),
      () => sendChatMessage({}, "request", forbidden),
      () => decideChatConfirmation({}, "request", forbidden),
      () => authorizePageChatSession({} as any, forbidden),
      () => updatePageChatSettingsFromCli({} as any, forbidden),
    ]) await expect(action()).rejects.toThrow("page_chat_engine_disabled");
    expect(await mirrorPageCommentIntoRoom({} as any, forbidden)).toBeNull();
  });
  test("dispatch and hook resume do not start or wake workflows", async () => {
    for (const action of [() => startPageChatTurn("old"), () => startRaviFollowUp("old", "old"), () => resumePageChatConfirmation("old", "confirmed")]) {
      await expect(action()).rejects.toThrow("page_chat_engine_disabled");
    }
  });
  test("old persisted steps cannot invoke model, operation, confirmation or askRavi", async () => {
    expect(await beginTurn("old", forbidden)).toEqual({ ok: false });
    for (const action of [
      () => runModelRound("old", forbidden), () => runToolCall("old", "call", forbidden),
      () => requestConfirmation("old", "call", forbidden), () => applyConfirmation("old", "call", "confirmation", "confirmed", forbidden),
      () => askRavi("old", "call", forbidden), () => checkRaviReply("old", "call", "request", true, forbidden),
    ]) await expect(action()).rejects.toThrow("page_chat_engine_disabled");
    expect(await postRaviFollowUp("old", "request", forbidden)).toEqual({ done: true });
    await finishTurn("old", "failed", "disabled", forbidden);
  });
  test("transport blocks even configured provider and implicit Gateway fallback", () => {
    for (const provider of [undefined, "deepseek"]) expect(() => pageChatModelTransport("deepseek/deepseek-chat", { user: "x", tags: [] }, {
      RAVI_PAGES_AI_ENABLED: "0", PAGE_CHAT_MODEL_PROVIDER: provider, DEEPSEEK_API_KEY: "synthetic-not-a-key",
    })).toThrow("page_chat_engine_disabled");
  });
});

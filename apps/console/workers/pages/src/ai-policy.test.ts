import { afterEach, expect, test } from "bun:test";
import worker, { type PagesWorkerEnv } from "./index";
import { pagesAiEnabled } from "./ai-policy";
import { replaceRaviChatTags } from "./chat-panel";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
test("direct text/voice/socket/ask routes refuse without Console or provider", async () => {
  let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error("network_forbidden"); }) as any;
  const env = { RAVI_PAGES_AI_ENABLED: "0", RAVI_CONSOLE_API_URL: "https://console.test", RAVI_PAGES_ASSETS: { get: async () => { calls++; throw new Error("storage_forbidden"); } } } as PagesWorkerEnv;
  for (const path of ["chat", "chat/open", "chat/send", "chat/confirm", "chat/socket", "page-chat", "page-chat/session", "page-chat/ask-ravi"]) {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request(`https://demo.ravi.page/_ravi/${path}`, { method }), env);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("page_chat_engine_disabled");
    }
  }
  expect(calls).toBe(0);
});
test("explicit exclusion beats embedded enabled metadata and signed-out login invitation", () => {
  const source = '<main>Keep data<ravi-chat enabled="true">Fallback invitation</ravi-chat><ravi-view id="v"></ravi-view></main>';
  const actual = replaceRaviChatTags(source, { enabled: true, excluded: true, path: "/", chatPath: "/_ravi/chat", chatOrigin: null, host: "demo.test", loginUrl: "/login", signedIn: false });
  expect(actual).toBe('<main>Keep data<ravi-view id="v"></ravi-view></main>');
  expect(pagesAiEnabled({})).toBe(true);
  for (const flag of ["0", "", "true", "invalid"]) expect(pagesAiEnabled({ RAVI_PAGES_AI_ENABLED: flag })).toBe(false);
});

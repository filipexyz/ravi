import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateAgent } from "../router/router-db.js";
import { getOrCreateSession, getSession } from "../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { updateRuntimeSessionMetadata } from "./session-launcher.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-launcher-metadata-");
  dbCreateAgent({ id: "crm", cwd: "/tmp/crm" });
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("updateRuntimeSessionMetadata", () => {
  it("never saves a relay's delivery override as the session's last chat", () => {
    const session = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    updateRuntimeSessionMetadata(session.sessionKey, {
      prompt: "[System] Inform: hi",
      source: { channel: "whatsapp", accountId: "", chatId: "5511900009999@s.whatsapp.net" },
      _turnOrigin: buildSessionRelayTurnOrigin("inform", { agentId: "crm", sessionKey: session.sessionKey }),
    });
    expect(getSession(session.sessionKey)?.lastTo ?? null).toBeNull();

    updateRuntimeSessionMetadata(session.sessionKey, {
      prompt: "oi",
      source: { channel: "whatsapp", accountId: "wa-main", chatId: "5511900001111@s.whatsapp.net" },
    });
    expect(getSession(session.sessionKey)?.lastTo).toBe("5511900001111@s.whatsapp.net");
  });
});

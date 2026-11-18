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

  it("never saves a thread completion addressed to the asking WhatsApp DM as the session's last chat", () => {
    const session = getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
    updateRuntimeSessionMetadata(session.sessionKey, {
      prompt: "oi do slack",
      source: { channel: "slack", accountId: "ravi-slack", instanceId: "ravi-slack", chatId: "D0C8BEV8QUR" },
    });
    expect(getSession(session.sessionKey)?.lastChannel).toBe("slack");

    updateRuntimeSessionMetadata(session.sessionKey, {
      prompt: "[System] Inform: Slack thread concluída.",
      source: { channel: "whatsapp", accountId: "main", chatId: "178035101794451@lid" },
      _slackThreadLifecycle: {
        eventId: "evt-1",
        eventType: "thread.closed",
        requestId: "slack-thread:req-1",
        parentSessionKey: session.sessionKey,
      },
    } as any);
    expect(getSession(session.sessionKey)?.lastChannel).toBe("slack");
    expect(getSession(session.sessionKey)?.lastTo).toBe("D0C8BEV8QUR");
  });
});

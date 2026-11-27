import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// End to end through the real Ask store: `sessions ask` from one agent's session records the grant,
// and `sessions answer` from the asked agent's session, which has no access to the asker, resolves
// the asker the same way the bash hook does (key, name, key-shaped name) and delivers only an answer.
// 26/11: the asked agent's answer was refused because nothing tied it to the Ask.
process.env.NATS_URL = "nats://127.0.0.1:1";

const published: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
mock.module("../../omni/session-stream.js", () => ({
  publishSessionPrompt: async (sessionName: string, payload: Record<string, unknown>) => {
    published.push({ sessionName, payload });
  },
}));

const { getOrCreateSession, updateSessionSource } = await import("../../router/sessions.js");
const { cleanupIsolatedRaviState, createIsolatedRaviState } = await import("../../test/ravi-state.js");
const { runWithContext } = await import("../context.js");
const { SessionCommands } = await import("./sessions.js");
const { findOpenAskGrant } = await import("../../sessions/ask-grants.js");
const { evaluateBashPermission } = await import("../../bash/hook.js");

const ASKER = "agent:asker:main";
const ASKED = "agent:asked:main";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sessions-ask-answer-");
  published.length = 0;
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

/** A turn of `agentId` in `sessionKey`: the scope is that agent's, with no grant on other sessions. */
function turnOf<T>(agentId: string, sessionKey: string, fn: () => T): T {
  return runWithContext({ agentId, sessionKey, sessionName: sessionKey, suppressCliOutput: true }, fn);
}

function setup(askerName = "cassia-omie") {
  getOrCreateSession(ASKER, "asker", "/tmp/asker", { name: askerName });
  getOrCreateSession(ASKED, "asked", "/tmp/asked", { name: "asked-main" });
}

async function ask(): Promise<void> {
  // The asker reaches the asked session as an operator would: the test grants it by running unscoped.
  await runWithContext({ sessionKey: ASKER, sessionName: "asker", suppressCliOutput: true }, () =>
    new SessionCommands().ask(ASKED, "pergunta", "Luís Filipe"),
  );
  published.length = 0;
}

describe("sessions answer through an open Ask, with the real store", () => {
  it.each([
    ["key", ASKER, "cassia-omie"],
    ["name", "cassia-omie", "cassia-omie"],
    ["key-shaped name", "agent:asker:review", "agent:asker:review"],
  ])("answers the asker named by its %s", async (_label, ref, askerName) => {
    setup(askerName);
    await ask();
    expect(findOpenAskGrant(ASKER, ASKED)).not.toBeNull();

    // The hook and the command agree on the same reference: both let this answer through.
    const turn = { agentId: "asked", sessionKey: ASKED, sessionName: ASKED };
    expect(
      runWithContext(turn, () => evaluateBashPermission(`ravi sessions answer ${ref} "resposta"`, turn)).allowed,
    ).toBe(true);

    const receipt = (await turnOf("asked", ASKED, () => new SessionCommands().answer(ref, "resposta"))) as Record<
      string,
      unknown
    >;

    expect(receipt.session).toEqual({ sessionKey: ASKER });
    expect(published).toHaveLength(1);
    expect(published[0]?.payload.prompt).toBe(`[System] Answer: [from: ${ASKED}] resposta`);
  });

  it("refuses the answer without an Ask, as if the asker did not exist", async () => {
    setup();
    await expect(turnOf("asked", ASKED, () => new SessionCommands().answer(ASKER, "resposta"))).rejects.toThrow(
      "Session not found",
    );
    expect(published).toHaveLength(0);
  });

  it("does not carry the answerer's chat as the asker's approval source", async () => {
    setup();
    // The asked session's last chat: a client group whose members must not approve the asker's tools.
    updateSessionSource(ASKED, { channel: "whatsapp", accountId: "luis", chatId: "120363431846316920@g.us" });
    await ask();

    await turnOf("asked", ASKED, () => new SessionCommands().answer(ASKER, "resposta"));

    expect(published).toHaveLength(1);
    expect(published[0]?.payload).not.toHaveProperty("_approvalSource");
  });

  it.each([
    ["--barrier", ["p0", undefined, undefined]],
    ["--steer", [undefined, true, undefined]],
    ["--immediate", [undefined, undefined, true]],
  ] as const)("refuses %s on an answer sent through an Ask", async (_flag, [barrier, steer, immediate]) => {
    setup();
    await ask();
    await expect(
      turnOf("asked", ASKED, () =>
        new SessionCommands().answer(ASKER, "resposta", undefined, undefined, undefined, barrier, steer, immediate),
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", message: expect.stringContaining("--barrier, --steer") });
    expect(published).toHaveLength(0);
  });

  it("refuses --channel and --to through an Ask as a permission denial", async () => {
    setup();
    await ask();
    await expect(
      turnOf("asked", ASKED, () => new SessionCommands().answer(ASKER, "resposta", undefined, "whatsapp")),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(published).toHaveLength(0);
  });

  it("leaves an answer from a caller with access to the asker as it was: approval source and barrier", async () => {
    setup();
    updateSessionSource(ASKED, { channel: "whatsapp", accountId: "luis", chatId: "5511900000001@s.whatsapp.net" });
    // Unscoped: the operator's own answer, with full access to the asker.
    await runWithContext({ sessionKey: ASKED, sessionName: "asked-main", suppressCliOutput: true }, () =>
      new SessionCommands().answer(ASKER, "resposta", undefined, undefined, undefined, undefined, true),
    );
    expect(published).toHaveLength(1);
    expect(published[0]?.payload._approvalSource).toEqual({
      channel: "whatsapp",
      accountId: "luis",
      chatId: "5511900000001@s.whatsapp.net",
    });
    expect(published[0]?.payload.deliveryBarrier).not.toBe("after_response");
  });
});

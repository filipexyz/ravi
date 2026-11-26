import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createBashPermissionHook, evaluateBashPermission } from "../bash/hook.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { ASK_GRANT_TTL_MS, findOpenAskGrant, recordAskGrant, revokeAskGrant } from "./ask-grants.js";

// 26/11: an agent asked by a WhatsApp group session ran the exact `ravi sessions answer <origin>`
// the Ask told it to, and the hook refused it ("cannot access session"). The asker never heard back.

const ORIGIN = "agent:convit-omie:whatsapp:main:group:120363431846316920";
const ASKED = "agent:main:main";
const THIRD = "agent:dev:main";

let stateDir: string | null = null;

function storeSession(key: string, name: string | null = null, createdAt = 1): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (session_key, name, agent_id, agent_cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(key, name, key.split(":")[1] ?? "x", "/tmp", createdAt, createdAt);
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-ask-grants-test-");
  storeSession(ORIGIN, "cassia-omie");
  storeSession(ASKED, "main-asked");
  storeSession(THIRD, "dev-third");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("ask grants store", () => {
  it("lets the asked session, and only it, answer the asker while the Ask is open", () => {
    const now = 1_000_000;
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED, sender: "Luís Filipe", now });

    expect(findOpenAskGrant(ORIGIN, ASKED, now + 1)?.sender).toBe("Luís Filipe");
    // A third session holds nothing.
    expect(findOpenAskGrant(ORIGIN, THIRD, now + 1)).toBeNull();
    // The asker does not gain an answer path into the asked session.
    expect(findOpenAskGrant(ASKED, ORIGIN, now + 1)).toBeNull();
    // No caller, no grant.
    expect(findOpenAskGrant(ORIGIN, undefined, now + 1)).toBeNull();
    // Closed: the window ended.
    expect(findOpenAskGrant(ORIGIN, ASKED, now + ASK_GRANT_TTL_MS)).toBeNull();
  });

  it("finds the asker by name, including a name shaped like a key that is not one", () => {
    storeSession("agent:ops:main", "agent:ops:review");
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    recordAskGrant({ originSessionKey: "agent:ops:main", targetSessionKey: ASKED });
    expect(findOpenAskGrant("cassia-omie", ASKED)).not.toBeNull();
    expect(findOpenAskGrant("agent:ops:review", ASKED)).not.toBeNull();
    expect(findOpenAskGrant("other-name", ASKED)).toBeNull();
  });

  it("has no grant for an Ask that was never made", () => {
    expect(findOpenAskGrant(ORIGIN, ASKED)).toBeNull();
  });

  it("records nothing for a session that does not exist", () => {
    expect(recordAskGrant({ originSessionKey: "agent:ghost:main", targetSessionKey: ASKED })).toBeNull();
    expect(recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: "agent:ghost:main" })).toBeNull();
  });

  it.each([
    ["asker", ORIGIN],
    ["asked", ASKED],
  ])("does not pass the grant to a %s session deleted and recreated under the same key", (_label, key) => {
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    getDb().prepare("DELETE FROM sessions WHERE session_key = ?").run(key);
    expect(findOpenAskGrant(ORIGIN, ASKED)).toBeNull();
    storeSession(key, null, 2);
    expect(findOpenAskGrant(ORIGIN, ASKED)).toBeNull();
  });

  it("withdraws a grant whose Ask was not delivered", () => {
    const grant = recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    revokeAskGrant(grant!.id);
    expect(findOpenAskGrant(ORIGIN, ASKED)).toBeNull();
  });
});

describe("bash hook: answering an open Ask", () => {
  // The asked agent's own turn: no access to the asker's session.
  const askedTurn = { agentId: "main", sessionKey: ASKED, sessionName: "main" };

  async function hookDenies(command: string, ctx: ToolContext = askedTurn): Promise<boolean> {
    const hook = createBashPermissionHook({ getAgentId: () => ctx.agentId });
    const result = (await runWithContext(ctx, () =>
      hook.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, null, {
        signal: new AbortController().signal,
      }),
    )) as Record<string, any>;
    return result.hookSpecificOutput?.permissionDecision === "deny";
  }

  it("refuses the answer when no Ask is open (the 26/11 failure)", async () => {
    expect(await hookDenies(`ravi sessions answer ${ORIGIN} "ok" "Luís Filipe"`)).toBe(true);
  });

  it("allows the answer the Ask asked for, by key and by name", async () => {
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED, sender: "Luís Filipe" });
    expect(await hookDenies(`ravi sessions answer ${ORIGIN} "ok" "Luís Filipe"`)).toBe(false);
    expect(await hookDenies(`ravi sessions answer cassia-omie "ok" "Luís Filipe"`)).toBe(false);
  });

  it.each([
    `ravi sessions answer --json ${ORIGIN} "ok"`,
    `ravi sessions answer --barrier followup ${ORIGIN} "ok"`,
    `ravi sessions answer --steer --json "${ORIGIN}" "ok"`,
  ])("reads the asker after leading options: %s", async (command) => {
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    expect(await hookDenies(command)).toBe(false);
  });

  it("does not take an option value for the asker", async () => {
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    // `--barrier` consumes the next token: the asker read here is the session after it.
    expect(await hookDenies(`ravi sessions answer --barrier ${ORIGIN} dev-third "ok"`)).toBe(true);
  });

  it.each(["read", "info", "send", "ask", "execute", "inform", "reset"])(
    "keeps refusing sessions %s on the asker while the Ask is open",
    async (verb) => {
      recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
      expect(await hookDenies(`ravi sessions ${verb} ${ORIGIN} "x"`)).toBe(true);
    },
  );

  it("refuses the answer to a session that is not the one asked", async () => {
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    expect(
      await hookDenies(`ravi sessions answer ${ORIGIN} "ok"`, {
        agentId: "dev",
        sessionKey: THIRD,
        sessionName: "dev",
      }),
    ).toBe(true);
  });

  it("refuses the answer once the Ask closed", () => {
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED, now: Date.now() - ASK_GRANT_TTL_MS - 1 });
    const decision = runWithContext(askedTurn, () =>
      evaluateBashPermission(`ravi sessions answer ${ORIGIN} "ok"`, askedTurn),
    );
    expect(decision.allowed).toBe(false);
  });
});

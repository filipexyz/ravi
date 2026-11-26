import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createBashPermissionHook, evaluateBashPermission } from "../bash/hook.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { ASK_GRANT_TTL_MS, findOpenAskGrant, recordAskGrant } from "./ask-grants.js";

// 26/11: an agent asked by a WhatsApp group session ran the exact `ravi sessions answer <origin>`
// the Ask told it to, and the hook refused it ("cannot access session"). The asker never heard back.

const ORIGIN = "agent:convit-omie:whatsapp:main:group:120363431846316920";
const ASKED = "agent:main:main";
const THIRD = "agent:dev:main";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-ask-grants-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function namedSession(key: string, name: string): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (session_key, name, agent_id, agent_cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(key, name, key.split(":")[1] ?? "x", "/tmp", Date.now(), Date.now());
}

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

  it("finds a session named in the command by its key", () => {
    namedSession(ORIGIN, "cassia-omie");
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED });
    expect(findOpenAskGrant("cassia-omie", ASKED)).not.toBeNull();
    expect(findOpenAskGrant("other-name", ASKED)).toBeNull();
  });

  it("has no grant for an Ask that was never made", () => {
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
    namedSession(ORIGIN, "cassia-omie");
    recordAskGrant({ originSessionKey: ORIGIN, targetSessionKey: ASKED, sender: "Luís Filipe" });
    expect(await hookDenies(`ravi sessions answer ${ORIGIN} "ok" "Luís Filipe"`)).toBe(false);
    expect(await hookDenies(`ravi sessions answer cassia-omie "ok" "Luís Filipe"`)).toBe(false);
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

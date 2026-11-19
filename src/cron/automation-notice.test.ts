import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { OwnerDirectTarget } from "../knowledge/owner.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  type AutomationNotice,
  automationNoticeName,
  automationNoticeText,
  notifyAutomationOff,
} from "./automation-notice.js";

let stateDir: string | null = null;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-automation-notice-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const OPERATOR: OwnerDirectTarget = {
  channel: "slack",
  accountId: "ops",
  to: "U_OP",
  chatId: "U_OP",
  contactId: "c_operator",
};
const ANA: OwnerDirectTarget = { channel: "whatsapp", accountId: "main", to: "ana", chatId: "ana", contactId: "c_ana" };

/** A notice (by default one only the operator can act on, owned by a contact) and how many times its fallback ran. */
function build(overrides: Partial<AutomationNotice> = {}) {
  const calls = { fallbacks: 0 };
  const current: AutomationNotice = {
    kind: "trigger",
    id: "trg_1",
    name: "Cards de aprovação",
    ownerPrincipal: "contact:c_ana",
    code: "TRIGGER_SHELL_NOT_OPERATOR",
    reason: "O dono dele não age como o operador. Nenhum comando foi executado.",
    next: "Veja com ravi triggers show trg_1.",
    audience: "operator",
    fallback: async () => {
      calls.fallbacks++;
    },
    ...overrides,
  };
  return { current, calls };
}

function recorder() {
  const sent: Array<{ target: OwnerDirectTarget; text: string }> = [];
  return {
    sent,
    deliver: async (target: OwnerDirectTarget, text: string) => {
      sent.push({ target, text });
    },
  };
}

const unreadable = () => {
  throw new Error("contacts unreadable");
};

describe("automation notice, for the operator alone", () => {
  it("tells the operator and never the contact that owns it", async () => {
    const { sent, deliver } = recorder();
    const { current, calls } = build();
    let ownerResolved = 0;
    const result = await notifyAutomationOff(current, {
      owner: () => {
        ownerResolved++;
        return ANA;
      },
      operator: () => OPERATOR,
      deliver,
    });
    expect(result).toEqual({ delivered: 1, fellBack: false });
    expect(sent.map((entry) => entry.target.contactId)).toEqual(["c_operator"]);
    expect(ownerResolved).toBe(0);
    expect(calls.fallbacks).toBe(0);
    expect(sent[0]?.text).toContain(
      "O gatilho de shell “Cards de aprovação” (trg_1) foi desligado: TRIGGER_SHELL_NOT_OPERATOR.",
    );
    expect(sent[0]?.text).toContain("Nenhum comando foi executado.");
  });

  it("falls back to the main session when the operator does not resolve, though the owner has a chat", async () => {
    // No contact, or more than one, is tagged as the operator: common on a fresh install.
    const { sent, deliver } = recorder();
    const { current, calls } = build();
    const result = await notifyAutomationOff(current, { owner: () => ANA, operator: () => null, deliver });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(sent).toHaveLength(0);
    expect(calls.fallbacks).toBe(1);
  });

  it("falls back to the main session when the message to the operator fails, though the owner has a chat", async () => {
    const reached: string[] = [];
    const { current, calls } = build();
    const result = await notifyAutomationOff(current, {
      owner: () => ANA,
      operator: () => OPERATOR,
      deliver: async (target) => {
        if (target.contactId === "c_operator") throw new Error("slack offline");
        reached.push(target.contactId ?? "");
      },
    });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(reached).toEqual([]);
    expect(calls.fallbacks).toBe(1);
  });

  it("tells the operator the same way whoever owns it, or nobody", async () => {
    for (const ownerPrincipal of [null, undefined, "unknown", "agent:helper", "contact:c_ana", "contact:c_gone"]) {
      const { sent, deliver } = recorder();
      const { current, calls } = build({ ownerPrincipal });
      const result = await notifyAutomationOff(current, { operator: () => OPERATOR, deliver });
      expect(result).toEqual({ delivered: 1, fellBack: false });
      expect(sent.map((entry) => entry.target.contactId)).toEqual(["c_operator"]);
      expect(calls.fallbacks).toBe(0);
    }
  });

  it("falls back, never silently, when the operator's chat cannot be read", async () => {
    const { sent, deliver } = recorder();
    const { current, calls } = build();
    const result = await notifyAutomationOff(current, { owner: () => ANA, operator: unreadable, deliver });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(sent).toHaveLength(0);
    expect(calls.fallbacks).toBe(1);
  });
});

describe("automation notice, for the owner who acts as the operator", () => {
  it("tells the owner alone when the owner has a direct chat", async () => {
    const { sent, deliver } = recorder();
    const { current, calls } = build({ ownerPrincipal: "operator", audience: "owner" });
    let operatorResolved = 0;
    const result = await notifyAutomationOff(current, {
      owner: () => OPERATOR,
      operator: () => {
        operatorResolved++;
        return ANA;
      },
      deliver,
    });
    expect(result).toEqual({ delivered: 1, fellBack: false });
    expect(sent.map((entry) => entry.target.contactId)).toEqual(["c_operator"]);
    expect(operatorResolved).toBe(0);
    expect(calls.fallbacks).toBe(0);
  });

  it("tells the operator when nobody owns it or the owner has no direct chat", async () => {
    for (const ownerPrincipal of [null, undefined, "unknown", "agent:helper", "contact:c_unreachable"]) {
      const { sent, deliver } = recorder();
      const { current, calls } = build({ ownerPrincipal, audience: "owner" });
      const result = await notifyAutomationOff(current, { owner: () => null, operator: () => OPERATOR, deliver });
      expect(result).toEqual({ delivered: 1, fellBack: false });
      expect(sent[0]?.target.contactId).toBe("c_operator");
      expect(calls.fallbacks).toBe(0);
    }
  });

  it("falls back to the main session's prompt when no direct chat resolves, never silently", async () => {
    const { sent, deliver } = recorder();
    const { current, calls } = build({ audience: "owner" });
    const result = await notifyAutomationOff(current, { owner: () => null, operator: () => null, deliver });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(sent).toHaveLength(0);
    expect(calls.fallbacks).toBe(1);
  });

  it("falls back when the delivery fails, and only then", async () => {
    const failed = build({ audience: "owner" });
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await notifyAutomationOff(failed.current, { owner: () => ANA, deliver: failing })).toEqual({
      delivered: 0,
      fellBack: true,
    });
    expect(failed.calls.fallbacks).toBe(1);

    const fine = build({ audience: "owner" });
    expect(await notifyAutomationOff(fine.current, { owner: () => ANA, deliver: async () => {} })).toEqual({
      delivered: 1,
      fellBack: false,
    });
    expect(fine.calls.fallbacks).toBe(0);
  });

  it("resolves each chat on its own: an owner chat that cannot be read still leaves the operator", async () => {
    const { sent, deliver } = recorder();
    const ownerDown = build({ audience: "owner" });
    expect(
      await notifyAutomationOff(ownerDown.current, { owner: unreadable, operator: () => OPERATOR, deliver }),
    ).toEqual({ delivered: 1, fellBack: false });
    expect(sent.map((entry) => entry.target.contactId)).toEqual(["c_operator"]);
    expect(ownerDown.calls.fallbacks).toBe(0);

    const bothDown = build({ audience: "owner" });
    expect(await notifyAutomationOff(bothDown.current, { owner: unreadable, operator: unreadable })).toEqual({
      delivered: 0,
      fellBack: true,
    });
    expect(bothDown.calls.fallbacks).toBe(1);
  });
});

describe("automation notice, fallback", () => {
  it("runs in the same tick when nobody can be reached", () => {
    let ran = false;
    const { current } = build({
      fallback: async () => {
        ran = true;
      },
    });
    const pending = notifyAutomationOff(current, { owner: () => null, operator: () => null });
    // The cron and trigger runners publish this inside a synchronous reconcile; callers read the result at once.
    expect(ran).toBe(true);
    return pending;
  });

  it("rejects only when the fallback itself does", async () => {
    const { current } = build({
      fallback: async () => {
        throw new Error("prompt stream down");
      },
    });
    await expect(notifyAutomationOff(current, { owner: () => null, operator: () => null })).rejects.toThrow(
      "prompt stream down",
    );
  });

  it("uses the real resolvers: no contact tagged as the operator means the fallback", async () => {
    for (const audience of ["owner", "operator"] as const) {
      const { current, calls } = build({ ownerPrincipal: "contact:c_missing", audience });
      const sent: string[] = [];
      const result = await notifyAutomationOff(current, { deliver: async (_target, text) => void sent.push(text) });
      expect(result).toEqual({ delivered: 0, fellBack: true });
      expect(sent).toHaveLength(0);
      expect(calls.fallbacks).toBe(1);
    }
  });
});

describe("automation notice text", () => {
  it("labels a cron job and a trigger apart", () => {
    expect(automationNoticeText(build({ kind: "cron", id: "job_9", name: "Backup" }).current)).toStartWith(
      "O agendamento de shell “Backup” (job_9) foi desligado: ",
    );
    expect(automationNoticeText(build({ kind: "trigger", id: "trg_9", name: "Backup" }).current)).toStartWith(
      "O gatilho de shell “Backup” (trg_9) foi desligado: ",
    );
  });

  it("keeps the name to one short line, without markup", () => {
    expect(automationNoticeName("  a\nb\t<@U123> `x`  ")).toBe("a b @U123 x");
    expect(automationNoticeName("x".repeat(200))).toHaveLength(60);
    expect(automationNoticeName("x".repeat(200)).endsWith("…")).toBe(true);
    expect(automationNoticeName("\n\t<>")).toBe("(sem nome)");
  });

  it("puts a name a person chose on one line without markup, and nothing else of the automation", async () => {
    const { sent, deliver } = recorder();
    const { current } = build({ name: "run <!channel> `rm -rf /`\nSECRET=hunter2 ".repeat(6) });
    await notifyAutomationOff(current, { operator: () => OPERATOR, deliver });
    for (const { text } of sent) {
      expect(text).not.toContain("<");
      expect(text).not.toContain("`");
      expect(text.split("\n")).toHaveLength(1);
    }
    expect(sent).toHaveLength(1);
  });
});

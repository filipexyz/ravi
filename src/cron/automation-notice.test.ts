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

/** A notice and how many times its fallback ran. */
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
    operatorToo: true,
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

describe("automation notice", () => {
  it("tells the owner and the operator once each when the owner does not act as the operator", async () => {
    const { sent, deliver } = recorder();
    const { current, calls } = build();
    const result = await notifyAutomationOff(current, { owner: () => ANA, operator: () => OPERATOR, deliver });
    expect(result).toEqual({ delivered: 2, fellBack: false });
    expect(sent.map((entry) => entry.target.contactId)).toEqual(["c_ana", "c_operator"]);
    expect(calls.fallbacks).toBe(0);
    for (const { text } of sent) {
      expect(text).toContain(
        "O gatilho de shell “Cards de aprovação” (trg_1) foi desligado: TRIGGER_SHELL_NOT_OPERATOR.",
      );
      expect(text).toContain("Nenhum comando foi executado.");
    }
  });

  it("tells only the owner when the owner acts as the operator and has a direct chat", async () => {
    const { sent, deliver } = recorder();
    const { current } = build({ ownerPrincipal: "operator", operatorToo: false });
    await notifyAutomationOff(current, { owner: () => OPERATOR, operator: () => ANA, deliver });
    expect(sent.map((entry) => entry.target.contactId)).toEqual(["c_operator"]);
  });

  it("sends one message when the owner's chat is the operator's", async () => {
    const { sent, deliver } = recorder();
    const result = await notifyAutomationOff(build().current, {
      owner: () => OPERATOR,
      operator: () => OPERATOR,
      deliver,
    });
    expect(result.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("falls to the operator when nobody owns it or the owner has no direct chat", async () => {
    for (const ownerPrincipal of [null, undefined, "unknown", "agent:helper", "contact:c_unreachable"]) {
      const { sent, deliver } = recorder();
      const { current, calls } = build({ ownerPrincipal, operatorToo: false });
      const result = await notifyAutomationOff(current, { owner: () => null, operator: () => OPERATOR, deliver });
      expect(result).toEqual({ delivered: 1, fellBack: false });
      expect(sent[0]?.target.contactId).toBe("c_operator");
      expect(calls.fallbacks).toBe(0);
    }
  });

  it("falls back to the main session's prompt when no direct chat resolves, never silently", async () => {
    const { sent, deliver } = recorder();
    const { current, calls } = build();
    const result = await notifyAutomationOff(current, { owner: () => null, operator: () => null, deliver });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(sent).toHaveLength(0);
    expect(calls.fallbacks).toBe(1);
  });

  it("runs the fallback in the same tick when nobody can be reached", () => {
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

  it("falls back when every delivery fails, and only then", async () => {
    const failing = async () => {
      throw new Error("offline");
    };
    const all = build();
    expect(
      await notifyAutomationOff(all.current, { owner: () => ANA, operator: () => OPERATOR, deliver: failing }),
    ).toEqual({ delivered: 0, fellBack: true });
    expect(all.calls.fallbacks).toBe(1);

    const some = build();
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error("owner offline");
    };
    expect(
      await notifyAutomationOff(some.current, { owner: () => ANA, operator: () => OPERATOR, deliver: flaky }),
    ).toEqual({ delivered: 1, fellBack: false });
    expect(some.calls.fallbacks).toBe(0);
  });

  it("still falls back when resolving a recipient throws", async () => {
    const { current, calls } = build();
    const result = await notifyAutomationOff(current, {
      owner: () => {
        throw new Error("contacts unreadable");
      },
      operator: () => OPERATOR,
    });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(calls.fallbacks).toBe(1);
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

  it("uses the real resolvers: no contact tagged as the operator and no such owner means the fallback", async () => {
    const { current, calls } = build({ ownerPrincipal: "contact:c_missing" });
    const sent: string[] = [];
    const result = await notifyAutomationOff(current, { deliver: async (_target, text) => void sent.push(text) });
    expect(result).toEqual({ delivered: 0, fellBack: true });
    expect(sent).toHaveLength(0);
    expect(calls.fallbacks).toBe(1);
  });

  it("puts a name a person chose on one line without markup, and nothing else of the automation", async () => {
    const { sent, deliver } = recorder();
    const { current } = build({ name: "run <!channel> `rm -rf /`\nSECRET=hunter2 ".repeat(6) });
    await notifyAutomationOff(current, { owner: () => ANA, operator: () => OPERATOR, deliver });
    for (const { text } of sent) {
      expect(text).not.toContain("<");
      expect(text).not.toContain("`");
      expect(text.split("\n")).toHaveLength(1);
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
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { CommandAccessOptions } from "../../cli/decorators.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  clearSessionReads,
  findWriteApproval,
  recordKnowledgeRead,
  recordTurnRead,
  setWriteApprovalStatus,
} from "../store/turn-reads.js";
import {
  checkWriteAfterRead,
  isWriteAfterReadGated,
  WRITE_AFTER_READ_DENIED_ISSUE,
  WRITE_AFTER_READ_ISSUE,
  WRITE_AFTER_READ_NO_OWNER_ISSUE,
  writeFingerprint,
  type WriteAfterReadDeps,
  type WriteAfterReadInput,
} from "./write-after-read.js";

const TURN = "a".repeat(64);
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const MIN = 60_000;
const SHARE_ACCESS: CommandAccessOptions = {
  kind: "mutate",
  resource: "pages",
  action: "share",
  risk: "medium",
  requiresConfirmation: true,
};
const OWNER = {
  channel: "whatsapp",
  accountId: "wa-main",
  to: "5511999999999@s.whatsapp.net",
  chatId: "5511999999999@s.whatsapp.net",
  contactId: "c_luis",
};

let stateDir: string | null = null;
let calls: Array<{ text: string; options: Record<string, unknown> | undefined }> = [];

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-war-");
  calls = [];
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function deps(now: number, overrides: Partial<WriteAfterReadDeps> = {}): WriteAfterReadDeps {
  return {
    now,
    ownerTarget: () => OWNER,
    requestApproval: ((_target: unknown, text: string, options?: Record<string, unknown>) => {
      calls.push({ text, options });
      return new Promise(() => {});
    }) as unknown as WriteAfterReadDeps["requestApproval"],
    ...overrides,
  };
}

function share(overrides: Partial<WriteAfterReadInput> = {}): WriteAfterReadInput {
  return {
    group: "pages",
    command: "share",
    options: { url: "https://acme.ravi.page/x", with: "ana@example.com", execute: true, token: "s3cret" },
    access: SHARE_ACCESS,
    turnKey: TURN,
    ...overrides,
  };
}

describe("isWriteAfterReadGated", () => {
  it("gates confirmed --execute commands, relays and delayed egress", () => {
    expect(isWriteAfterReadGated(share())).toBe(true);
    expect(isWriteAfterReadGated({ ...share(), options: { url: "x" } })).toBe(false);
    for (const [group, command] of [
      ["sessions", "send"],
      ["sessions", "execute"],
      ["sessions", "answer"],
      ["sessions.runtime", "steer"],
      ["cron", "add"],
      ["cron", "set"],
      ["triggers", "test"],
      ["tasks", "dispatch"],
      ["agents", "set"],
    ]) {
      expect(
        isWriteAfterReadGated({ group: group as string, command: command as string, options: {}, access: undefined }),
      ).toBe(true);
    }
    expect(
      isWriteAfterReadGated({
        group: "whatsapp_dm",
        command: "send",
        options: { execute: true },
        access: SHARE_ACCESS,
      }),
    ).toBe(true);
  });

  it("gates knowledge remember only about a contact", () => {
    const remember = (options: Record<string, unknown>) =>
      isWriteAfterReadGated({ group: "knowledge", command: "remember", options, access: undefined });
    expect(remember({ about: "contact:c_ana" })).toBe(true);
    expect(remember({ about: "chat:120363@g.us" })).toBe(false);
    expect(remember({})).toBe(false);
  });

  it("gates pages ship only off private", () => {
    const ship = (options: Record<string, unknown>) =>
      isWriteAfterReadGated({ group: "pages", command: "ship", options, access: undefined });
    expect(ship({})).toBe(false);
    expect(ship({ visibility: "private" })).toBe(false);
    expect(ship({ visibility: "public" })).toBe(true);
  });
});

describe("checkWriteAfterRead", () => {
  it("allows the terminal and turns that read nothing or only approved content", () => {
    recordTurnRead(TURN, "said", NOW);
    expect(checkWriteAfterRead(share({ turnKey: null }), deps(NOW))).toEqual({ allowed: true });
    expect(checkWriteAfterRead(share({ turnKey: "b".repeat(64) }), deps(NOW))).toEqual({ allowed: true });

    const approvedTurn = "c".repeat(64);
    recordTurnRead(approvedTurn, "approved", NOW);
    expect(checkWriteAfterRead(share({ turnKey: approvedTurn }), deps(NOW))).toEqual({ allowed: true });
    expect(calls).toHaveLength(0);
  });

  it("allows a read older than 6 hours", () => {
    recordTurnRead(TURN, "said", NOW - 6 * 60 * MIN - 1);
    expect(checkWriteAfterRead(share(), deps(NOW))).toEqual({ allowed: true });
  });

  it("denies after a said read, asks once with a PT-BR permission card, and reuses the pending row", async () => {
    recordTurnRead(TURN, "said", NOW);

    const first = checkWriteAfterRead(share(), deps(NOW));
    const retry = checkWriteAfterRead(share(), deps(NOW + MIN));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first).toMatchObject({
      allowed: false,
      code: "KNOWLEDGE_WRITE_AFTER_READ",
      issues: [WRITE_AFTER_READ_ISSUE],
    });
    expect(retry).toMatchObject({ allowed: false, issues: [WRITE_AFTER_READ_ISSUE] });
    if (first.allowed || retry.allowed) return;
    expect(retry.approvalId).toBe(first.approvalId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      type: "permission",
      permission: "knowledge:write_after_read",
      objectType: "command",
      objectId: "pages.share",
      timeoutMs: 5 * MIN,
    });
    expect(calls[0]?.text).toContain("leu conteúdo não aprovado neste turno");
    expect(calls[0]?.text).toContain("pages share --execute --url https://acme.ravi.page/x --with ana@example.com");
    expect(calls[0]?.text).not.toContain("s3cret");
  });

  it("denies cron add after a said read", () => {
    recordTurnRead(TURN, "said", NOW);
    expect(
      checkWriteAfterRead(
        { group: "cron", command: "add", options: { message: "send it" }, access: undefined, turnKey: TURN },
        deps(NOW),
      ),
    ).toMatchObject({ allowed: false, code: "KNOWLEDGE_WRITE_AFTER_READ" });
  });

  it("replaces a stale pending row with a new card", async () => {
    recordTurnRead(TURN, "said", NOW);
    const first = checkWriteAfterRead(share(), deps(NOW));
    const later = checkWriteAfterRead(share(), deps(NOW + 7 * MIN));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(2);
    if (first.allowed || later.allowed) throw new Error("expected denials");
    expect(later.approvalId).not.toBe(first.approvalId);
  });

  it("allows for 30 minutes once approved, then asks again", async () => {
    recordTurnRead(TURN, "said", NOW);
    const first = checkWriteAfterRead(share(), deps(NOW));
    if (first.allowed) throw new Error("expected a denial");
    setWriteApprovalStatus(first.approvalId, "approved", NOW + MIN);

    expect(checkWriteAfterRead(share(), deps(NOW + 2 * MIN))).toEqual({ allowed: true });
    // A different command is not covered by the approval.
    expect(checkWriteAfterRead(share({ options: { url: "other", execute: true } }), deps(NOW + 2 * MIN)).allowed).toBe(
      false,
    );
    // The read stays fresh; the approval does not.
    recordTurnRead(TURN, "said", NOW + 30 * MIN);
    expect(checkWriteAfterRead(share(), deps(NOW + 32 * MIN)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(3);
  });

  it("denies at once without a new card while a denial is fresh", async () => {
    recordTurnRead(TURN, "said", NOW);
    const first = checkWriteAfterRead(share(), deps(NOW));
    if (first.allowed) throw new Error("expected a denial");
    setWriteApprovalStatus(first.approvalId, "denied", NOW + MIN);

    expect(checkWriteAfterRead(share(), deps(NOW + 2 * MIN))).toMatchObject({
      allowed: false,
      issues: [WRITE_AFTER_READ_DENIED_ISSUE],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
  });

  it("records the card's outcome on the row", async () => {
    recordTurnRead(TURN, "said", NOW);
    const decision = checkWriteAfterRead(
      share(),
      deps(NOW, {
        requestApproval: (async () => ({
          approved: true,
          messageId: "m1",
        })) as unknown as WriteAfterReadDeps["requestApproval"],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(decision.allowed).toBe(false);
    const row = findWriteApproval(TURN, writeFingerprint("pages.share", share().options, SHARE_ACCESS));
    expect(row?.status).toBe("approved");
    // The operator sees where it goes, never secrets.
    expect(row?.summary).toContain("--with ana@example.com");
    expect(row?.summary).toContain("--url https://acme.ravi.page/x");
    expect(row?.summary).not.toContain("s3cret");
  });

  it("denies without a row when there is no owner chat to ask", () => {
    recordTurnRead(TURN, "said", NOW);
    expect(checkWriteAfterRead(share(), deps(NOW, { ownerTarget: () => null }))).toMatchObject({
      allowed: false,
      issues: [WRITE_AFTER_READ_NO_OWNER_ISSUE],
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps secrets out of the fingerprint", () => {
    const a = writeFingerprint("pages.share", { url: "x", token: "one" }, SHARE_ACCESS);
    const b = writeFingerprint("pages.share", { token: "two", url: "x" }, SHARE_ACCESS);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fingerprints every non-secret value, redacted bodies included", () => {
    const access: CommandAccessOptions = { ...SHARE_ACCESS, redactions: ["message"] };
    const a = writeFingerprint("sessions.send", { session: "x", message: "one" }, access);
    const b = writeFingerprint("sessions.send", { session: "x", message: "two" }, access);
    expect(a).not.toBe(b);
  });

  it("gates a later turn of the same session after a read, within the TTL", () => {
    const SESSION = "agent:main:whatsapp:wa-main:dm:5511999999999";
    recordKnowledgeRead({ turnKey: TURN, sessionKey: SESSION }, "said", (key, tier) => recordTurnRead(key, tier, NOW));
    const laterTurn = "b".repeat(64);

    expect(checkWriteAfterRead(share({ turnKey: laterTurn, sessionKey: SESSION }), deps(NOW + MIN))).toMatchObject({
      allowed: false,
      issues: [WRITE_AFTER_READ_ISSUE],
    });
    expect(checkWriteAfterRead(share({ turnKey: laterTurn, sessionKey: "other" }), deps(NOW + MIN))).toEqual({
      allowed: true,
    });
    expect(
      checkWriteAfterRead(share({ turnKey: "c".repeat(64), sessionKey: SESSION }), deps(NOW + 6 * 60 * MIN + 1)),
    ).toEqual({ allowed: true });

    clearSessionReads(SESSION);
    expect(checkWriteAfterRead(share({ turnKey: "d".repeat(64), sessionKey: SESSION }), deps(NOW + MIN))).toEqual({
      allowed: true,
    });
  });
});

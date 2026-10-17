import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getRecentHistory, saveMessage } from "../../db.js";
import { getOrCreateSession } from "../../router/sessions.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { deleteChatDbSessionMessages } from "./chat-db.js";
import { isSubjectForgotten, listForgottenSubjectIds, markSubjectForgotten } from "./forgotten.js";
import { getLocalRun, insertLocalRun, listLocalRuns } from "./local-runs.js";
import {
  findWriteApproval,
  lowestTierReadInTurn,
  recordTurnRead,
  setWriteApprovalStatus,
  TURN_READ_TTL_MS,
  upsertWriteApproval,
} from "./turn-reads.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-knowledge-rows-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("turn reads and write approvals", () => {
  it("keeps the lowest tier and expires after the TTL", () => {
    const now = 1_000_000_000;
    recordTurnRead("t1", "approved", now);
    expect(lowestTierReadInTurn("t1", now)).toBe("approved");
    recordTurnRead("t1", "said", now + 1);
    recordTurnRead("t1", "published", now + 2);
    expect(lowestTierReadInTurn("t1", now + 2)).toBe("said");
    expect(lowestTierReadInTurn("t1", now + 3 + TURN_READ_TTL_MS)).toBeNull();
    expect(lowestTierReadInTurn(null)).toBeNull();
  });

  it("upserts approvals by (turn, fingerprint) and updates status", () => {
    upsertWriteApproval({
      id: "wa-1",
      turnKey: "t1",
      fingerprint: "fp",
      summary: "remember a fact",
      status: "pending",
      requestedAt: 1,
      decidedAt: null,
    });
    expect(findWriteApproval("t1", "fp")?.status).toBe("pending");
    expect(setWriteApprovalStatus("wa-1", "approved", 5)).toBe(true);
    expect(findWriteApproval("t1", "fp")).toMatchObject({ status: "approved", decidedAt: 5 });
    expect(setWriteApprovalStatus("missing", "denied")).toBe(false);
  });
});

describe("local runs", () => {
  it("stores refs, tiers, hash and issues; lists newest first; reads with the kl: prefix", () => {
    const first = insertLocalRun({
      turnKey: "t1",
      sessionName: "dev-main",
      consoleRunId: "kr:1",
      queryHash: "a".repeat(64),
      refs: [{ ref: "km:1", trust: "said" }],
      lowestTier: "said",
      issues: ["console_not_logged_in"],
      now: 10,
    });
    insertLocalRun({
      turnKey: "t2",
      sessionName: "dev-other",
      consoleRunId: null,
      queryHash: "b".repeat(64),
      refs: [],
      lowestTier: null,
      issues: [],
      now: 20,
    });
    expect(getLocalRun(`kl:${first.id}`)).toEqual(first);
    expect(listLocalRuns({ limit: 10 }).map((run) => run.createdAt)).toEqual([20, 10]);
    expect(listLocalRuns({ turnKey: "t1", limit: 10 }).map((run) => run.id)).toEqual([first.id]);
    expect(listLocalRuns({ session: "dev-other", limit: 10 })).toHaveLength(1);
  });
});

describe("forgotten subjects", () => {
  it("marks and lists forgotten ids", () => {
    expect(isSubjectForgotten("contact_a")).toBe(false);
    markSubjectForgotten({ scope: "contact", subjectId: "contact_a" });
    markSubjectForgotten({ scope: "chat", subjectId: " chat_b " });
    expect(isSubjectForgotten("contact_a")).toBe(true);
    expect(isSubjectForgotten("chat_b")).toBe(true);
    expect([...listForgottenSubjectIds()].sort()).toEqual(["chat_b", "contact_a"]);
  });
});

describe("deleteChatDbSessionMessages", () => {
  it("deletes rows stored under the session name when given the key", () => {
    getOrCreateSession("agent:dev:knowledge-curator:abc", "dev", "/tmp/dev", { name: "dev-curator-abc" });
    saveMessage("dev-curator-abc", "user", "quoted history", null, { channel: "knowledge-curator" });
    saveMessage("dev-curator-abc", "assistant", "items", null, { channel: "knowledge-curator" });
    saveMessage("dev-main", "user", "keep me", null, { channel: "whatsapp" });
    expect(deleteChatDbSessionMessages("agent:dev:knowledge-curator:abc")).toBe(2);
    expect(getRecentHistory("dev-curator-abc", 10)).toHaveLength(0);
    expect(getRecentHistory("dev-main", 10)).toHaveLength(1);
    expect(deleteChatDbSessionMessages("  ")).toBe(0);
  });
});

import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { openPublicationJournal } from "./journal.js";
import type { PublicationPlan } from "./contracts.js";

let db: Database;
afterEach(() => db?.close());
const plan: PublicationPlan = {
  repo: "o/r",
  base: "dev",
  head: "fix/publish",
  localSha: "a".repeat(40),
  treeSha: "b".repeat(40),
  remoteSha: null,
  commitCount: 1,
  objectCount: 3,
  uploadBytes: 100,
  refAction: "create",
  prAction: "create",
  prNumber: null,
  replySession: "publisher",
  followAction: "reconcile",
};
it("leases a branch across SHAs, releases it, and keeps a stable publication ID across attempts", () => {
  db = new Database(":memory:");
  const first = openPublicationJournal(plan, { actor: "agent:test" }, db);
  expect(() => openPublicationJournal({ ...plan, localSha: "c".repeat(40) }, {}, db)).toThrow("Another publication");
  first.close();
  const second = openPublicationJournal(plan, {}, db);
  expect(second.publicationId).toBe(first.publicationId);
  expect(second.attemptId).not.toBe(first.attemptId);
  second.close();
});
it("fails closed if the audit store breaks or an expired lease is acquired by another attempt", () => {
  db = new Database(":memory:");
  const first = openPublicationJournal(plan, {}, db);
  db.exec("UPDATE pr_publication_leases SET expires_at=0");
  const second = openPublicationJournal(plan, {}, db);
  expect(() => first.record("objects", "intent")).toThrow("audit could not be persisted");
  first.close();
  second.record("objects", "intent");
  db.exec("DROP TABLE pr_publication_events");
  expect(() => second.record("objects", "confirmed")).toThrow("audit could not be persisted");
  second.close();
});

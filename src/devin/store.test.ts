import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  getDevinDbPath,
  getDevinSession,
  listDevinAttachments,
  listDevinMessages,
  listDevinSessions,
  upsertDevinAttachments,
  upsertDevinMessages,
  upsertDevinSession,
} from "./store.js";

let stateDir: string | null = null;

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "devin-test",
    org_id: "org_123",
    url: "https://app.devin.ai/s/devin-test",
    status: "running",
    status_detail: "working",
    title: "Test Session",
    tags: ["ravi", "test"],
    pull_requests: [],
    structured_output: {},
    acus_consumed: 0,
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

describe("Devin store", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-devin-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("uses a dedicated devin.db and upserts sessions by remote id", () => {
    const first = upsertDevinSession(fakeSession(), {
      originType: "task",
      originId: "task-123",
      taskId: "task-123",
      lastSyncedAt: 10,
    });
    const second = upsertDevinSession(fakeSession({ status: "exit", status_detail: "finished", updated_at: 3 }));

    expect(first.id).toBe(second.id);
    expect(second.status).toBe("exit");
    expect(second.statusDetail).toBe("finished");
    expect(second.originType).toBe("task");
    expect(second.taskId).toBe("task-123");
    expect(existsSync(getDevinDbPath())).toBe(true);
    expect(second.devinId).toBe("devin-test");
    expect(getDevinDbPath()).toBe(`${stateDir}/devin.db`);
  });

  it("lists and filters local sessions", () => {
    upsertDevinSession(fakeSession({ session_id: "a", status: "running", tags: ["ravi"] }));
    upsertDevinSession(fakeSession({ session_id: "devin-b", status: "suspended", tags: ["other"] }));

    expect(listDevinSessions({ status: "running" }).map((session) => session.devinId)).toEqual(["devin-a"]);
    expect(listDevinSessions({ tag: "other" }).map((session) => session.devinId)).toEqual(["devin-b"]);
    expect(getDevinSession("devin-a")?.status).toBe("running");
  });

  it("upserts messages and attachments idempotently", () => {
    upsertDevinSession(fakeSession());
    upsertDevinMessages("devin-test", [
      { event_id: "evt-1", created_at: 1, source: "devin", message: "first" },
      { event_id: "evt-1", created_at: 1, source: "devin", message: "first edited" },
    ]);
    upsertDevinAttachments("devin-test", [
      {
        attachment_id: "att-1",
        name: "report.md",
        source: "devin",
        url: "https://example.test/report.md",
        content_type: "text/markdown",
      },
    ]);

    expect(listDevinMessages("devin-test")).toHaveLength(1);
    expect(listDevinMessages("devin-test")[0]?.message).toBe("first edited");
    expect(listDevinAttachments("devin-test")).toHaveLength(1);
    expect(listDevinAttachments("devin-test")[0]?.name).toBe("report.md");
  });

  it("configures WAL journal mode on the devin database", () => {
    upsertDevinSession(fakeSession());
    const checkDb = new Database(getDevinDbPath(), { readonly: true });
    try {
      const row = checkDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
      expect(row?.journal_mode).toBe("wal");
    } finally {
      checkDb.close();
    }
  });

  it("handles concurrent session upserts and message writes without lock errors", async () => {
    upsertDevinSession(fakeSession());

    const writers = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => {
        upsertDevinSession(fakeSession({ status: `status-${i}`, updated_at: 100 + i }));
        upsertDevinMessages(
          "devin-test",
          Array.from({ length: 20 }, (_, j) => ({
            event_id: `evt-${i}-${j}`,
            created_at: Date.now(),
            source: "devin",
            message: `msg-${i}-${j}`,
          })),
        );
      }),
    );

    const readers = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => {
        listDevinSessions();
        listDevinMessages("devin-test");
        listDevinAttachments("devin-test");
      }),
    );

    await Promise.all([...writers, ...readers]);

    const session = getDevinSession("devin-test");
    expect(session).not.toBeNull();
    const messages = listDevinMessages("devin-test");
    expect(messages.length).toBeGreaterThan(0);
  });
});

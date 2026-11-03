import { afterEach, beforeEach, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolvePublicationContext } from "./context.js";
import { openPublicationJournal } from "./journal.js";

let state: string | null = null;
beforeEach(async () => {
  state = await createIsolatedRaviState("ravi-pr-session-");
  getDb()
    .query(`INSERT INTO sessions(session_key,name,agent_id,agent_cwd,created_at,updated_at,last_channel,last_account_id,last_to,last_thread_id)
    VALUES ('agent:test:publisher','publisher','test','/tmp',0,0,'slack','main','C-test','thread-1')`)
    .run();
});
afterEach(async () => {
  await cleanupIsolatedRaviState(state);
});

it("persists audit through a dedicated real SQLite connection and shares its lease with other connections", () => {
  const plan = {
    repo: "o/r",
    head: "fix/test",
    base: "dev",
    localSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    remoteSha: null,
    commitCount: 1,
    objectCount: 3,
    uploadBytes: 100,
    refAction: "create" as const,
    prAction: "create" as const,
    prNumber: null,
    replySession: "publisher",
    followAction: "reconcile" as const,
  };
  const first = openPublicationJournal(plan, { actor: "agent:test" });
  try {
    expect(() => openPublicationJournal(plan, {})).toThrow("Another publication");
    first.record("objects", "intent");
    expect(getDb().query("SELECT COUNT(*) AS count FROM pr_publication_events").get()).toEqual({ count: 2 });
  } finally {
    first.close();
  }
  const second = openPublicationJournal(plan, {});
  expect(second.publicationId).toBe(first.publicationId);
  second.close();
});
const context: ToolContext = {
  agentId: "test",
  sessionKey: "agent:test:publisher",
  sessionName: "publisher",
  context: {
    contextId: "ctx_publisher",
    contextKey: "rctx_publisher",
    kind: "turn-runtime",
    agentId: "test",
    capabilities: [],
    createdAt: 0,
  },
};
it("uses the publishing session and its actual reply thread without mutating session state", () => {
  const before = getDb().query("SELECT * FROM sessions").all();
  expect(runWithContext(context, () => resolvePublicationContext())).toMatchObject({
    agentId: "test",
    sessionKey: "agent:test:publisher",
    sessionName: "publisher",
    source: { channel: "slack", accountId: "main", chatId: "C-test", threadId: "thread-1" },
  });
  const source = { channel: "slack", accountId: "main", chatId: "C-inbound", threadId: "current-thread" };
  expect(runWithContext({ ...context, source }, () => resolvePublicationContext()).source).toEqual(source);
  expect(getDb().query("SELECT * FROM sessions").all()).toEqual(before);
});
it("refuses cross-session routing, absent sessions and sessions with no chat destination", () => {
  expect(() => runWithContext(context, () => resolvePublicationContext("other-session"))).toThrow("own session");
  expect(() =>
    runWithContext({ ...context, sessionKey: "missing", sessionName: "missing" }, () => resolvePublicationContext()),
  ).toThrow("unavailable in this scope");
  getDb().exec("UPDATE sessions SET last_to=NULL");
  expect(() => runWithContext(context, () => resolvePublicationContext())).toThrow("no chat destination");
  expect(() => runWithContext({}, () => resolvePublicationContext())).toThrow("--reply-session");
});

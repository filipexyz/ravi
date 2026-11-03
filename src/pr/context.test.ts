import { afterEach, beforeEach, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { getDb } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { resolvePublicationContext } from "./context.js";

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

import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { ContractError } from "../cli/agent-contract.js";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { STATE_SCHEMA_VERSION } from "../db/schema-owner.js";
import { PREPARE_STATE_COMMAND } from "../db/state-readiness.js";
import { closeRouterDb, getDb, getRaviDbPath } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runThreadMutation, usesThreadSchemaFence } from "../threads/schema-fence.js";
import { resolvePublicationContext, resolvePublicationFollowContext } from "./context.js";
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
  transport: "gateway",
  agentId: "test",
  sessionKey: "agent:test:publisher",
  sessionName: "publisher",
  context: {
    contextId: "ctx_publisher",
    contextKey: "rctx_publisher",
    kind: "turn-runtime",
    agentId: "test",
    sessionKey: "agent:test:publisher",
    sessionName: "publisher",
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
  expect(
    runWithContext({ ...context, context: { ...context.context!, source } }, () => resolvePublicationContext()).source,
  ).toEqual(source);
  expect(getDb().query("SELECT * FROM sessions").all()).toEqual(before);
});
it("keeps the publishing session's destination when the turn only borrowed an approval origin", () => {
  const borrowed = { channel: "slack", accountId: "main", chatId: "D-caller-dm" };
  // A relayed turn: the caller's chat routes approval cards only, never this session's CI follow.
  const relayed = {
    ...context,
    context: { ...context.context!, metadata: { approvalSource: borrowed, approvalSourceOnly: true } },
  };
  expect(runWithContext(relayed, () => resolvePublicationContext()).source).toEqual({
    channel: "slack",
    accountId: "main",
    chatId: "C-test",
    threadId: "thread-1",
  });
  // An older record that still stored the borrowed origin in `source` is filtered by its marker.
  const legacy = {
    ...context,
    context: { ...context.context!, source: borrowed, metadata: { approvalSourceOnly: true } },
  };
  expect(runWithContext(legacy, () => resolvePublicationContext()).source).toMatchObject({ chatId: "C-test" });
});
it("fails closed when ambient session aliases disagree with the authenticated session", () => {
  expect(() =>
    runWithContext({ ...context, sessionKey: "other-session", sessionName: "other-session" }, () =>
      resolvePublicationContext(),
    ),
  ).toThrow("unavailable in this scope");
});
it("refuses absent sessions and sessions with no chat destination", () => {
  expect(() =>
    runWithContext(
      { ...context, context: { ...context.context!, sessionKey: "missing", sessionName: "missing" } },
      () => resolvePublicationContext(),
    ),
  ).toThrow("unavailable in this scope");
  getDb().exec("UPDATE sessions SET last_to=NULL");
  expect(() => runWithContext(context, () => resolvePublicationContext())).toThrow("no chat destination");
});
it("lets a session name only itself as the reply session", () => {
  for (const own of ["publisher", "agent:test:publisher"]) {
    expect(runWithContext(context, () => resolvePublicationContext(own)).sessionKey).toBe("agent:test:publisher");
  }
  expect(() => runWithContext(context, () => resolvePublicationContext("other-session"))).toThrow("own session");
});
it("refuses a runtime context that belongs to no session, whatever reply session it names", () => {
  const sessionless: ToolContext[] = [
    { transport: "gateway" },
    { transport: "tool", agentId: "test", sessionKey: "agent:test:publisher" },
    { ...context, context: { ...context.context!, sessionKey: undefined, sessionName: undefined } },
  ];
  for (const candidate of sessionless) {
    for (const reply of [undefined, "publisher", "agent:test:publisher"]) {
      expect(() => runWithContext(candidate, () => resolvePublicationContext(reply))).toThrow(
        "requires an authenticated session context",
      );
    }
  }
});
it("lets the operator's terminal publish into the session it names, which is a destination and no more", () => {
  const before = getDb().query("SELECT * FROM sessions").all();
  // No transport: the terminal, acting as the local operator, with or without a stored credential.
  const terminals: ToolContext[] = [{}, { ...context, transport: undefined, contextOrigin: "default-credential" }];
  for (const terminal of terminals) {
    for (const reply of ["publisher", "agent:test:publisher", " publisher "]) {
      expect(runWithContext(terminal, () => resolvePublicationContext(reply))).toMatchObject({
        agentId: "test",
        sessionKey: "agent:test:publisher",
        sessionName: "publisher",
        source: { channel: "slack", accountId: "main", chatId: "C-test", threadId: "thread-1" },
      });
    }
    // No destination, one that does not exist: refused before any publication IO.
    expect(() => runWithContext(terminal, () => resolvePublicationContext())).toThrow("--reply-session <session>");
    expect(() => runWithContext(terminal, () => resolvePublicationContext("  "))).toThrow("--reply-session <session>");
    expect(() => runWithContext(terminal, () => resolvePublicationContext("missing"))).toThrow(
      "unavailable in this scope",
    );
  }
  // One with no chat.
  getDb().exec("UPDATE sessions SET last_to=NULL");
  expect(() => runWithContext({}, () => resolvePublicationContext("publisher"))).toThrow("no chat destination");
  getDb().exec("UPDATE sessions SET last_to='C-test'");
  expect(getDb().query("SELECT * FROM sessions").all()).toEqual(before);
});

/** The state directory as it is before the daemon prepares it: no session store. */
function removeSessionStore(): string {
  closeRouterDb();
  const path = getRaviDbPath();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  return path;
}
function refusal(run: () => unknown): ContractError {
  try {
    run();
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("Expected the publication context to be refused.");
}
const follow = {
  agentId: "test",
  sessionKey: "agent:test:publisher",
  sessionName: "publisher",
  accountId: "main",
  source: { channel: "slack", accountId: "main", chatId: "C-test", threadId: "thread-1" },
};
/** Every way publication reads sessions, each expected to refuse state the daemon has not prepared. */
function expectNotPreparedAtEveryEntry(): void {
  const refusals = {
    session: refusal(() => runWithContext(context, () => resolvePublicationContext())),
    terminal: refusal(() => runWithContext({}, () => resolvePublicationContext("publisher"))),
    follow: refusal(() => resolvePublicationFollowContext(follow)),
  };
  for (const [entry, error] of Object.entries(refusals)) {
    expect({ entry, op: error.op, code: error.code, exitCode: error.exitCode }).toEqual({
      entry,
      op: "pr publish",
      code: "STATE_SCHEMA_NOT_READY",
      exitCode: 1,
    });
    expect(error.message).toContain(PREPARE_STATE_COMMAND);
    expect(error.details).toMatchObject({ retryable: true });
    expect(String(error.details.suggestedAction)).toContain(PREPARE_STATE_COMMAND);
  }
}
it("refuses state the daemon has not prepared under its own code, with the command that prepares it", () => {
  const path = removeSessionStore();
  expectNotPreparedAtEveryEntry();
  // Refusing is all it does: the store is the daemon's to create.
  expect(existsSync(path)).toBe(false);
});

/** The router marker as another release, or a boot that did not finish, leaves it. */
function writeRouterMarker(sql: string, ...values: string[]): void {
  const db = getDb();
  if (usesThreadSchemaFence(db)) runThreadMutation(db, sql, ...values);
  else db.query(sql).run(...values);
}
const routerMarker = () =>
  getDb().query("SELECT version FROM state_schema_versions WHERE component = 'router'").get() as {
    version: string;
  } | null;
it("refuses a session store that is there but that this release's daemon has not prepared", () => {
  const sessions = getDb().query("SELECT * FROM sessions").all();
  expect(routerMarker()?.version).toBe(STATE_SCHEMA_VERSION);
  // Prepared by another release: the sessions table is there and would have answered.
  writeRouterMarker("UPDATE state_schema_versions SET version = ? WHERE component = ?", "1:0.0.0-other", "router");
  expectNotPreparedAtEveryEntry();
  // Left by a boot that did not finish: no marker at all.
  writeRouterMarker("DELETE FROM state_schema_versions WHERE component = ?", "router");
  expectNotPreparedAtEveryEntry();
  // Refusing is all it does: the marker is the daemon's to write, and no session is touched.
  expect(routerMarker()).toBeNull();
  expect(getDb().query("SELECT * FROM sessions").all()).toEqual(sessions);
  // Prepared again, the same store answers.
  writeRouterMarker(
    "INSERT INTO state_schema_versions (component, version) VALUES (?, ?)",
    "router",
    STATE_SCHEMA_VERSION,
  );
  expect(resolvePublicationFollowContext(follow)).toMatchObject({ agentId: "test", sessionName: "publisher" });
  expect(runWithContext(context, () => resolvePublicationContext()).sessionKey).toBe("agent:test:publisher");
});
it("keeps reporting a follow session that is gone as a missing session when the store is there", () => {
  expect(resolvePublicationFollowContext(follow)).toMatchObject({ agentId: "test", sessionName: "publisher" });
  const gone = refusal(() =>
    resolvePublicationFollowContext({ agentId: "test", sessionKey: "agent:test:gone", sessionName: "gone" }),
  );
  expect({ code: gone.code, message: gone.message }).toEqual({
    code: "PUBLICATION_SESSION_REQUIRED",
    message: "Cannot register PR follow: durable session is missing.",
  });
});

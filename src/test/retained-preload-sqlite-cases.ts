/**
 * Real SQLite scenarios for a child process using retained-memory-preload.ts.
 * This module registers no hooks, launches no process and performs no cleanup.
 * The launcher must inspect memory-sql-snapshot.json after the child exits:
 * assertions inside a test cannot establish that the preload's afterAll passed.
 */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { isAbsolute, join, relative, sep } from "node:path";

type SentinelRow = { value: string };

export interface RetainedSqliteSnapshotExpectation {
  requested: string;
  tables?: Record<string, SentinelRow[]>;
  errorIncludes?: string;
}

/** A serializable oracle for the launcher, independent of preload implementation. */
export interface RetainedSqliteScenarioResult {
  scenario: string;
  expectedExit: "success" | "failure";
  expectedSnapshots: RetainedSqliteSnapshotExpectation[];
  observations: Record<string, string | boolean | number | null>;
}

/** Refuses a fixture invocation outside explicitly retained, synthetic roots. */
function retainedStateRoot(): string {
  const state = process.env.PR795_RETAINED_STATE;
  const evidence = process.env.PR795_RUN_EVIDENCE;
  assert.ok(state && evidence && isAbsolute(state) && isAbsolute(evidence), "Missing retained fixture roots");
  const child = relative(evidence, state);
  assert.ok(child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child), "State must belong to evidence");
  return state;
}

/** Uses real SQL and finalizes its own statements so strict-close tests start idle. */
function seed(db: Database, value: string): void {
  db.exec("CREATE TABLE retained_sentinel (value TEXT NOT NULL)");
  append(db, value);
  const journal = db.prepare<{ journal_mode: string }, []>("PRAGMA journal_mode");
  try {
    assert.equal(journal.get()?.journal_mode, "memory", "The actual preload must redirect SQLite to memory");
  } finally {
    journal.finalize();
  }
}

function append(db: Database, value: string): void {
  const statement = db.prepare("INSERT INTO retained_sentinel (value) VALUES (?)");
  try {
    statement.run(value);
  } finally {
    statement.finalize();
  }
}

/** Reaches the real database; a no-op close fails this assertion. */
function assertClosed(db: Database): void {
  assert.throws(() => db.query("SELECT value FROM retained_sentinel").all());
}

function expected(requested: string, ...values: string[]): RetainedSqliteSnapshotExpectation {
  return { requested, tables: { retained_sentinel: values.map((value) => ({ value })) } };
}

function success(
  scenario: string,
  expectedSnapshots: RetainedSqliteSnapshotExpectation[],
  observations: RetainedSqliteScenarioResult["observations"] = {},
): RetainedSqliteScenarioResult {
  return { scenario, expectedExit: "success", expectedSnapshots, observations };
}

/** Minimal RED: a normal caller closes a populated memory DB before preload afterAll. */
export function closedMemoryScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "closed-before-afterAll");
  const returned = db.close();
  assert.equal(returned, undefined);
  assertClosed(db);
  return success("closed-memory", [expected(":memory:", "closed-before-afterAll")], { actualClose: true });
}

/** An open connection must be read at afterAll, including its most recent mutation. */
export function liveLatestScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "live-first");
  append(db, "live-latest");
  return success("live-latest", [expected(":memory:", "live-first", "live-latest")], { leftOpen: true });
}

/** Two Database instances with one requested path remain two separate snapshots. */
export function sameRequestDistinctScenario(): RetainedSqliteScenarioResult {
  const requested = join(retainedStateRoot(), "same-request.sqlite");
  const first = new Database(requested);
  const second = Database.open(requested);
  assert.notEqual(first, second);
  seed(first, "first-connection");
  seed(second, "second-connection");
  first.close();
  assertClosed(first);
  append(second, "second-latest");
  return success(
    "same-request-distinct",
    [expected(requested, "first-connection"), expected(requested, "second-connection", "second-latest")],
    { firstClosed: true, secondLeftOpen: true },
  );
}

/** Explicit false must still invoke Bun's real close and preserve its return value. */
export function closeFalseScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "explicit-false");
  assert.equal(db.close(false), undefined);
  assertClosed(db);
  return success("close-false", [expected(":memory:", "explicit-false")], { actualClose: true });
}

/** Snapshot statements must not make an otherwise idle strict close fail. */
export function closeTrueIdleScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "strict-idle");
  assert.equal(db.close(true), undefined);
  assertClosed(db);
  return success("close-true-idle", [expected(":memory:", "strict-idle")], { actualClose: true });
}

/** Calling close repeatedly must not query a closed DB or replace retained rows. */
export function doubleCloseScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "double-close");
  assert.equal(db.close(), undefined);
  assertClosed(db);
  assert.equal(db.close(), undefined);
  assert.equal(db.close(false), undefined);
  assert.equal(db.close(true), undefined);
  assertClosed(db);
  return success("double-close", [expected(":memory:", "double-close")], { closeCalls: 4, actualClose: true });
}

/** Resource disposal must preserve the same real-close and retained-data contract. */
export function disposeScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "disposed-before-afterAll");
  assert.equal(typeof db[Symbol.dispose], "function");
  assert.equal(db[Symbol.dispose](), undefined);
  assertClosed(db);
  assert.equal(db[Symbol.dispose](), undefined);
  assert.equal(db.close(), undefined);
  return success("dispose", [expected(":memory:", "disposed-before-afterAll")], { actualDispose: true });
}

/** Native disposal must capture writes made by a close decorator before it delegates. */
export function disposeDecoratedCloseScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "before-dispose");
  const trackedClose = db.close;
  const calls: Array<{ receiverMatches: boolean; args: unknown[] }> = [];
  let rowsBeforeNativeClose: SentinelRow[] | undefined;
  Object.defineProperty(db, "close", {
    configurable: true,
    writable: true,
    value(this: Database, ...args: unknown[]) {
      calls.push({ receiverMatches: this === db, args });
      append(this, "written-in-close");
      const statement = this.prepare<SentinelRow, []>("SELECT value FROM retained_sentinel ORDER BY rowid");
      try {
        rowsBeforeNativeClose = statement.all();
      } finally {
        statement.finalize();
      }
      return Reflect.apply(trackedClose, this, args);
    },
  });
  assert.equal(db[Symbol.dispose](), undefined);
  assert.deepEqual(calls, [{ receiverMatches: true, args: [true] }]);
  const expectation = expected(":memory:", "before-dispose", "written-in-close");
  assert.deepEqual(rowsBeforeNativeClose, expectation.tables?.retained_sentinel);
  assert.throws(() => db.exec("SELECT 1"), /closed/i);
  return success("dispose-decorated-close", [expectation], {
    actualDispose: true,
    decoratedCloseCalls: calls.length,
  });
}

/**
 * Discovery/control for the installed Bun build, deliberately separate from RED.
 * A pending uncached statement may make close(true) fail. When it does, the
 * caller must receive that native error, remain able to mutate the connection,
 * and retain the later rows on a successful retry. Never assume failure merely
 * because the type declaration permits it; the launcher records the outcome.
 */
export function closeTrueBusyScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "busy-first");
  append(db, "busy-second");
  const statement = db.prepare<SentinelRow, []>("SELECT value FROM retained_sentinel ORDER BY rowid");
  const iterator = statement.iterate();
  assert.deepEqual(iterator.next(), { done: false, value: { value: "busy-first" } });
  let closeError: unknown;
  try {
    db.close(true);
  } catch (error) {
    closeError = error;
  }
  if (closeError === undefined) {
    assertClosed(db);
    return success("close-true-busy", [expected(":memory:", "busy-first", "busy-second")], {
      strictCloseThrew: false,
      nativeError: null,
    });
  }
  append(db, "after-failed-close");
  iterator.return?.();
  statement.finalize();
  assert.equal(db.close(), undefined);
  assertClosed(db);
  return success("close-true-busy", [expected(":memory:", "busy-first", "busy-second", "after-failed-close")], {
    strictCloseThrew: true,
    nativeError: String(closeError),
  });
}

/**
 * Injects a snapshot-query exception on this connection's own methods only.
 * Bun's defensive SQLite mode prevents the catalog-corruption approach, so this
 * tests persistent capture-error evidence, not a native corruption/error path.
 * The separate real control DB proves the injection is not prototype-wide.
 * If close captures the failure, the caller catches it and removes the injection;
 * a later successful capture must not erase the original failure from afterAll.
 */
export function snapshotQueryErrorCaughtScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "must-not-mask-query-error");
  const controlDb = new Database(":memory:");
  seed(controlDb, "control-query-unaffected");
  const injectedFailure = new Error("TEST_RETAINED_SQLITE_SNAPSHOT_QUERY_FAILURE");
  let injectFailure = true;
  let injectedCalls = 0;
  const intercept = (original: Database["query"] | Database["prepare"]) =>
    function (this: Database, ...args: unknown[]) {
      if (injectFailure) {
        injectedCalls += 1;
        throw injectedFailure;
      }
      return Reflect.apply(original, this, args);
    };
  Object.defineProperties(db, {
    query: { configurable: true, writable: true, value: intercept(db.query) },
    prepare: { configurable: true, writable: true, value: intercept(db.prepare) },
  });
  let closeError: unknown;
  try {
    db.close();
  } catch (error) {
    closeError = error;
  }
  const injectedDuringClose = injectedCalls > 0;
  // Keep the baseline injection armed until its afterAll first attempts capture.
  if (injectedDuringClose) injectFailure = false;
  let stillOpen = false;
  let retryErrorCaught = false;
  try {
    db.exec("SELECT 1");
    stillOpen = true;
  } catch {
    // A successful native close is allowed even when its preceding capture failed.
  }
  if (stillOpen && injectedDuringClose) {
    append(db, "after-caught-capture-error");
    try {
      db.close();
    } catch {
      // A sticky capture failure may be thrown again; afterAll still owns the oracle.
      retryErrorCaught = true;
    }
    if (!retryErrorCaught) assertClosed(db);
  }
  assert.deepEqual(controlDb.query("SELECT value FROM retained_sentinel").all(), [
    { value: "control-query-unaffected" },
  ]);
  return {
    scenario: "snapshot-query-error-caught",
    expectedExit: "failure",
    expectedSnapshots: [
      { requested: ":memory:", errorIncludes: injectedFailure.message },
      expected(":memory:", "control-query-unaffected"),
    ],
    observations: {
      failureSource: "injected-own-query-and-prepare",
      injectedCallsBeforeAfterAll: injectedCalls,
      closeErrorCaught: closeError !== undefined,
      nativeCloseCompleted: !stillOpen,
      retryErrorCaught,
    },
  };
}

/** A real strict-close failure must leave afterAll responsible for the latest live rows. */
export function failedCloseLiveScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "failed-close-live-first");
  append(db, "failed-close-live-second");
  const statement = db.prepare<SentinelRow, []>("SELECT value FROM retained_sentinel ORDER BY rowid");
  const iterator = statement.iterate();
  assert.deepEqual(iterator.next(), { done: false, value: { value: "failed-close-live-first" } });
  let closeError: unknown;
  try {
    db.close(true);
  } catch (error) {
    closeError = error;
  }
  assert.ok(closeError instanceof Error, "The native strict close must fail with the pending real statement");
  assert.match(String(closeError), /locked|busy|unfinalized/i);
  iterator.return?.();
  statement.finalize();
  append(db, "failed-close-live-latest");
  const expectation = expected(
    ":memory:",
    "failed-close-live-first",
    "failed-close-live-second",
    "failed-close-live-latest",
  );
  assert.deepEqual(
    db.query("SELECT value FROM retained_sentinel ORDER BY rowid").all(),
    expectation.tables?.retained_sentinel,
  );
  return success("failed-close-live", [expectation], {
    strictCloseThrew: true,
    nativeError: String(closeError),
    leftOpen: true,
  });
}

/**
 * Combines an injected capture failure with a real strict-close failure, then
 * restores query methods and leaves the recovered connection open. The final
 * capture must contain its latest real rows AND the earlier injected error.
 * Only capture failure is injected; close itself is always the native operation.
 */
export function snapshotErrorThenLiveScenario(): RetainedSqliteScenarioResult {
  const db = new Database(":memory:");
  seed(db, "snapshot-error-live-first");
  append(db, "snapshot-error-live-second");
  const statement = db.prepare<SentinelRow, []>("SELECT value FROM retained_sentinel ORDER BY rowid");
  const iterator = statement.iterate();
  assert.deepEqual(iterator.next(), { done: false, value: { value: "snapshot-error-live-first" } });
  const originalQuery = db.query;
  const originalPrepare = db.prepare;
  const injectedFailure = new Error("TEST_RETAINED_SQLITE_SNAPSHOT_ERROR_THEN_LIVE");
  let injectedCalls = 0;
  const failCapture = () => {
    injectedCalls += 1;
    throw injectedFailure;
  };
  Object.defineProperties(db, {
    query: { configurable: true, writable: true, value: failCapture },
    prepare: { configurable: true, writable: true, value: failCapture },
  });
  let closeError: unknown;
  try {
    db.close(true);
  } catch (error) {
    closeError = error;
  } finally {
    db.query = originalQuery;
    db.prepare = originalPrepare;
  }
  assert.ok(injectedCalls > 0, "The real preload must attempt capture before native close");
  assert.ok(closeError instanceof Error, "The native strict close must still fail with the pending real statement");
  assert.notEqual(closeError, injectedFailure, "Capture failure must not replace the native close exception");
  assert.match(String(closeError), /locked|busy|unfinalized/i);
  iterator.return?.();
  statement.finalize();
  append(db, "snapshot-error-live-latest");
  const expectation = {
    ...expected(":memory:", "snapshot-error-live-first", "snapshot-error-live-second", "snapshot-error-live-latest"),
    errorIncludes: injectedFailure.message,
  };
  assert.deepEqual(
    db.query("SELECT value FROM retained_sentinel ORDER BY rowid").all(),
    expectation.tables?.retained_sentinel,
  );
  return {
    scenario: "snapshot-error-then-live",
    expectedExit: "failure",
    expectedSnapshots: [expectation],
    observations: {
      failureSource: "injected-own-query-and-prepare",
      injectedCallsBeforeAfterAll: injectedCalls,
      strictCloseThrew: true,
      nativeError: String(closeError),
      queryMethodsRestored: true,
      leftOpen: true,
    },
  };
}

export const retainedSqliteScenarios = {
  "closed-memory": closedMemoryScenario,
  "live-latest": liveLatestScenario,
  "same-request-distinct": sameRequestDistinctScenario,
  "close-false": closeFalseScenario,
  "close-true-idle": closeTrueIdleScenario,
  "double-close": doubleCloseScenario,
  dispose: disposeScenario,
  "dispose-decorated-close": disposeDecoratedCloseScenario,
  "close-true-busy": closeTrueBusyScenario,
  "snapshot-query-error-caught": snapshotQueryErrorCaughtScenario,
  "failed-close-live": failedCloseLiveScenario,
  "snapshot-error-then-live": snapshotErrorThenLiveScenario,
} as const;

export type RetainedSqliteScenarioName = keyof typeof retainedSqliteScenarios;

/** Run exactly one scenario in a child already using the actual retained preload. */
export function runRetainedSqliteScenario(name: string): RetainedSqliteScenarioResult {
  retainedStateRoot();
  assert.ok(Object.hasOwn(retainedSqliteScenarios, name), `Unknown retained SQLite scenario: ${name}`);
  return retainedSqliteScenarios[name as RetainedSqliteScenarioName]();
}

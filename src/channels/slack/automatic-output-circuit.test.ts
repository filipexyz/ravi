import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeRouterDb, getDb } from "../../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import {
  getSlackAutomaticOutputDecision,
  reserveSlackAutomaticOutput,
  SLACK_AUTOMATIC_OUTPUT_POLICY,
  type SlackAutomaticOutputDecision,
  type SlackAutomaticOutputReservation,
} from "./automatic-output-circuit.js";

const WINDOW = 300_000;
const SCOPE = "slack:installation-1:C123";

describe("Slack durable automatic terminal response circuit", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-slack-output-circuit-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("uses an explicit four-response rolling five-minute policy", () => {
    expect(SLACK_AUTOMATIC_OUTPUT_POLICY).toEqual({ maxOutputs: 4, rollingWindowMs: WINDOW, cooldownMs: WINDOW });
    expect(Object.isFrozen(SLACK_AUTOMATIC_OUTPUT_POLICY)).toBe(true);
    expect(getSlackAutomaticOutputDecision("absent")).toBeNull();
  });

  it("admits four responses and fixes the fifth candidate's cooldown without extending it", () => {
    for (let i = 0; i < 4; i++) expect(reserve(`response-${i}`, 100 + i).status).toBe("allowed");
    const fifth = reserve("fifth", 104);
    expect(fifth).toEqual({
      status: "suppressed",
      reason: "slack_bot_reply_cooldown",
      decidedAt: 104,
      recoverAt: WINDOW + 104,
    });
    for (const now of [105, 1_000, WINDOW + 103]) {
      expect(reserve(`during-${now}`, now)).toMatchObject({
        status: "suppressed",
        recoverAt: WINDOW + 104,
      });
    }
    expect(reserve("after", WINDOW + 105).status).toBe("allowed");
    expect(reserve("fifth", 2 * WINDOW, { sourceReceivedAt: 104 })).toEqual(fifth);
  });

  it("shares one frozen complete manifest admission across text, multipart and media retries", () => {
    const original = reserve("turn-1:destination", 100, { requestFingerprint: "final:text+part1+part2+media" });
    for (let i = 0; i < 20; i++) {
      expect(
        reserve("turn-1:destination", 200 + i, {
          requestFingerprint: "final:text+part1+part2+media",
          sourceReceivedAt: 100,
        }),
      ).toEqual(original);
    }
    for (let i = 0; i < 3; i++) expect(reserve(`other-${i}`, 300 + i).status).toBe("allowed");
    expect(reserve("overflow", 304).status).toBe("suppressed");
    // Even a retry after another response opened the circuit keeps its grant.
    expect(
      reserve("turn-1:destination", 400, {
        requestFingerprint: "final:text+part1+part2+media",
        sourceReceivedAt: 100,
      }),
    ).toEqual(original);
  });

  it("fails closed on changed terminal outcome, membership, destination or provenance without overwriting", () => {
    const original = reserve("frozen", 100, { requestFingerprint: "final:complete-manifest" });
    for (const change of [
      { requestFingerprint: "safe-error:complete-manifest" },
      { requestFingerprint: "final:complete-manifest+extra-media" },
      { scope: "slack:installation-2:C123" },
      { sourceId: "another-input" },
      { sourceReceivedAt: 101 },
    ]) {
      expect(
        reserve("frozen", 200, { requestFingerprint: "final:complete-manifest", sourceReceivedAt: 100, ...change }),
      ).toEqual({ status: "suppressed", reason: "slack_bot_reply_identity_conflict", decidedAt: 100 });
    }
    expect(getSlackAutomaticOutputDecision("frozen")).toEqual(original);
    for (let i = 0; i < 3; i++) expect(reserve(`remaining-${i}`, 201 + i).status).toBe("allowed");
    expect(reserve("overflow", 205).status).toBe("suppressed");
  });

  it("uses a rolling window so a wall-clock window boundary cannot refill a burst", () => {
    for (let i = 0; i < 4; i++) expect(reserve(`before-boundary-${i}`, WINDOW - 1).status).toBe("allowed");
    expect(reserve("after-boundary", WINDOW + 1)).toMatchObject({
      status: "suppressed",
      reason: "slack_bot_reply_cooldown",
    });
  });

  it("ages each admission out at the rolling boundary without a periodic reset", () => {
    for (let i = 0; i < 4; i++) expect(reserve(`initial-${i}`, 100 + i).status).toBe("allowed");
    expect(reserve("new-at-boundary", WINDOW + 100).status).toBe("allowed");
    expect(reserve("still-full", WINDOW + 100).status).toBe("suppressed");
  });

  it("requires a new input accepted strictly after recovery, including for delayed unseen response IDs", () => {
    for (let i = 0; i < 4; i++) reserve(`initial-${i}`, 100);
    const suppressed = reserve("suppressed-before-recovery", 101);
    const recoverAt = suppressed.recoverAt!;
    for (const sourceReceivedAt of [99, 101, recoverAt - 1, recoverAt]) {
      expect(reserve(`delayed-${sourceReceivedAt}`, recoverAt + 1, { sourceReceivedAt })).toEqual({
        status: "suppressed",
        reason: "slack_bot_reply_stale_source",
        decidedAt: recoverAt + 1,
        recoverAt,
      });
    }
    expect(reserve("fresh-input", recoverAt + 1).status).toBe("allowed");
    expect(reserve("suppressed-before-recovery", recoverAt + 2, { sourceReceivedAt: 101 })).toEqual(suppressed);
    // A delayed part from an already admitted complete manifest is still a retry.
    expect(reserve("initial-0", recoverAt + 2, { sourceReceivedAt: 100 })).toEqual({
      status: "allowed",
      decidedAt: 100,
    });
  });

  it("persists decisions and the source floor across reopen and long idle periods without free refills", () => {
    for (let i = 0; i < 4; i++) reserve(`initial-${i}`, 100);
    closeRouterDb();
    const suppressed = reserve("after-restart", 101);
    expect(suppressed.status).toBe("suppressed");
    closeRouterDb();
    expect(reserve("during-restart", 102).recoverAt).toBe(suppressed.recoverAt);
    closeRouterDb();
    const muchLater = 30 * 24 * 60 * 60 * 1_000;
    expect(reserve("after-restart", muchLater, { sourceReceivedAt: 101 })).toEqual(suppressed);
    expect(reserve("initial-0", muchLater, { sourceReceivedAt: 100 })).toEqual({ status: "allowed", decidedAt: 100 });
    expect(reserve("late-unseen", muchLater, { sourceReceivedAt: 102 })).toMatchObject({
      status: "suppressed",
      reason: "slack_bot_reply_stale_source",
      recoverAt: suppressed.recoverAt,
    });
    expect(reserve("fresh-after-idle", muchLater).status).toBe("allowed");
  });

  it("isolates caller-supplied canonical installation and channel scopes", () => {
    for (let i = 0; i < 4; i++) reserve(`initial-${i}`, 100);
    expect(reserve("full", 101).status).toBe("suppressed");
    expect(reserve("another-installation", 101, { scope: "slack:installation-2:C123" }).status).toBe("allowed");
    expect(reserve("another-channel", 101, { scope: "slack:installation-1:C456" }).status).toBe("allowed");
  });

  it("rolls back the cooldown when persisting its terminal decision fails", () => {
    for (let i = 0; i < 4; i++) reserve(`initial-${i}`, 100);
    getDb().exec(`
      CREATE TRIGGER reject_circuit_decision BEFORE INSERT ON slack_automatic_output_decisions
      BEGIN SELECT RAISE(ABORT, 'injected decision failure'); END;
    `);
    expect(() => reserve("failed", 101)).toThrow("injected decision failure");
    expect(getSlackAutomaticOutputDecision("failed")).toBeNull();
    getDb().exec("DROP TRIGGER reject_circuit_decision");
    expect(reserve("retried", 102).recoverAt).toBe(WINDOW + 102);
  });

  it("documents that changing-content slow ping-pong below the bound can continue", () => {
    for (let i = 0; i < 20; i++) {
      expect(
        reserve(`slow-peer-response-${i}`, 100 + i * (WINDOW + 1), { requestFingerprint: `different-content-${i}` })
          .status,
      ).toBe("allowed");
    }
  });

  it("retains only compact identity metadata and indexes the allowed rolling window", () => {
    reserve("metadata", 100);
    const columns = (
      getDb().prepare("PRAGMA table_info(slack_automatic_output_decisions)").all() as Array<{ name: string }>
    ).map(({ name }) => name);
    expect(columns).toEqual([
      "idempotency_key",
      "request_fingerprint",
      "scope",
      "source_id",
      "source_received_at",
      "status",
      "reason",
      "decided_at",
      "recover_at",
    ]);
    const indexes = getDb().prepare("PRAGMA index_list(slack_automatic_output_decisions)").all() as Array<{
      name: string;
      partial: number;
    }>;
    expect(indexes).toContainEqual(expect.objectContaining({ name: "idx_slack_automatic_output_window", partial: 1 }));
  });

  it("rejects missing identities and invalid timestamps before reserving", () => {
    for (const field of ["idempotencyKey", "requestFingerprint", "scope", "sourceId"] as const) {
      expect(() => reserve("invalid", 100, { [field]: " " })).toThrow(`${field} is required`);
    }
    for (const sourceReceivedAt of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => reserve("invalid", 100, { sourceReceivedAt })).toThrow("sourceReceivedAt");
    }
    expect(() => reserve("invalid", Number.NaN)).toThrow();
    expect(getSlackAutomaticOutputDecision("invalid")).toBeNull();
  });

  it("serializes two processes racing the last allowance and deduplicates a shared manifest", async () => {
    if (!stateDir) throw new Error("isolated state missing");
    for (let i = 0; i < 3; i++) reserve(`initial-${i}`, 100);
    const raced = await raceProcesses(stateDir, [input("racer-a", 101), input("racer-b", 101)]);
    expect(raced.map((decision) => decision.status).sort()).toEqual(["allowed", "suppressed"]);
    expect(reserve("after-race", 102).status).toBe("suppressed");

    const duplicateScope = "slack:installation-1:C-duplicate";
    for (let i = 0; i < 3; i++) reserve(`duplicate-initial-${i}`, 100, { scope: duplicateScope });
    const duplicateInput = input("shared-manifest", 101, { scope: duplicateScope });
    const duplicates = await raceProcesses(stateDir, [duplicateInput, duplicateInput]);
    expect(duplicates).toEqual([
      { status: "allowed", decidedAt: 101 },
      { status: "allowed", decidedAt: 101 },
    ]);
    expect(reserve("after-duplicate", 102, { scope: duplicateScope }).status).toBe("suppressed");
  }, 30_000);
});

function input(
  key: string,
  now: number,
  overrides: Partial<SlackAutomaticOutputReservation> = {},
): SlackAutomaticOutputReservation {
  return {
    idempotencyKey: key,
    requestFingerprint: `manifest:${key}`,
    scope: SCOPE,
    sourceId: `source:${key}`,
    sourceReceivedAt: now,
    now,
    ...overrides,
  };
}

function reserve(key: string, now: number, overrides: Partial<SlackAutomaticOutputReservation> = {}) {
  return reserveSlackAutomaticOutput(input(key, now, overrides));
}

/**
 * Races reservations in separate Bun processes sharing the caller's isolated
 * SQLite state. Requires nonempty inputs and an unused directory derived from
 * the first idempotency key; each worker initializes its schema before release.
 * Returns decisions in input order and rejects on worker failure. Coordination
 * cleanup kills and awaits remaining children; the caller owns disk-state teardown.
 */
async function raceProcesses(
  stateDir: string,
  inputs: SlackAutomaticOutputReservation[],
): Promise<SlackAutomaticOutputDecision[]> {
  const runDir = join(stateDir, `race-${inputs[0]!.idempotencyKey}`);
  mkdirSync(runDir);
  const isolatedHome = join(runDir, "home");
  mkdirSync(isolatedHome);
  const fixture = join(runDir, "worker.test.ts");
  const preload = fileURLToPath(new URL("../../test/isolated-runtime-preload.ts", import.meta.url));
  writeFileSync(
    fixture,
    `import { test, expect, mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
const config = JSON.parse(process.env.TEST_CIRCUIT_WORKER);
const actualOs = { ...(await import("node:os")) };
mock.module("node:os", () => ({ ...actualOs, homedir: () => config.home }));
process.env.RAVI_STATE_DIR = config.stateDir;
test("reserve from separate SQLite connection", async () => {
  const circuit = await import(${JSON.stringify(new URL("./automatic-output-circuit.ts", import.meta.url).href)});
  const router = await import(${JSON.stringify(new URL("../../router/router-db.ts", import.meta.url).href)});
  try {
    circuit.getSlackAutomaticOutputDecision("warm-schema");
    writeFileSync(config.ready, "ready");
    const deadline = Date.now() + 10000;
    while (!existsSync(config.start) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(existsSync(config.start)).toBe(true);
    writeFileSync(config.result, JSON.stringify(circuit.reserveSlackAutomaticOutput(config.input)));
  } finally { router.closeRouterDb(); }
}, 15000);
`,
  );
  const start = join(runDir, "start");
  const workers = inputs.map((workerInput, index) => {
    const ready = join(runDir, `ready-${index}`);
    const result = join(runDir, `result-${index}.json`);
    const child = spawn(process.execPath, ["test", "--preload", preload, fixture], {
      env: {
        ...process.env,
        TEST_CIRCUIT_WORKER: JSON.stringify({ stateDir, home: isolatedHome, ready, result, start, input: workerInput }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => {
      log += chunk;
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Circuit worker failed (${code}): ${log}`)),
      );
    });
    // Keep an early startup failure handled until the coordination loop awaits it.
    void exited.catch(() => {});
    return { child, ready, result, exited };
  });
  try {
    const deadline = Date.now() + 10_000;
    while (workers.some((worker) => !existsSync(worker.ready)) && Date.now() < deadline) {
      if (workers.some((worker) => worker.child.exitCode !== null))
        await Promise.all(workers.map((worker) => worker.exited));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(workers.every((worker) => existsSync(worker.ready))).toBe(true);
    writeFileSync(start, "start");
    await Promise.all(workers.map((worker) => worker.exited));
    return workers.map((worker) => JSON.parse(readFileSync(worker.result, "utf8")) as SlackAutomaticOutputDecision);
  } finally {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
    await Promise.allSettled(workers.map((worker) => worker.exited));
  }
}

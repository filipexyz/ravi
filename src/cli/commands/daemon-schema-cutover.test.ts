import { afterEach, describe, expect, it } from "bun:test";
import { sleep, spawn } from "bun";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonSchemaPhase } from "../../db/daemon-schema-owner.js";
import { performSupervisedDaemonRestart, type ManagedDaemonProcess } from "../daemon-restart-supervision.js";

const fixture = join(import.meta.dir, "../../db/fixtures/schema-lock-worker.ts");
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(5);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    return false;
  }
}

function daemon(root: string, name: string, pmId: number) {
  writeFileSync(join(root, `${name}.ready-go`), "go");
  const startedAt = Date.now();
  const child = spawn([process.execPath, "--no-env-file", fixture, "daemon", root, name], {
    cwd: root,
    env: { RAVI_STATE_DIR: root, TZ: "UTC" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const registration: ManagedDaemonProcess = { name: "ravi", pmId, pid: child.pid, status: "online", startedAt };
  return { child, registration };
}

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ravi-schema-cutover-test-")));
  roots.push(root);
  const predecessor = daemon(root, "predecessor", 4);
  await until(() => existsSync(join(root, "predecessor.ready")), "predecessor readiness");
  expect(readDaemonSchemaPhase(predecessor.registration, root)).toBe("ready");
  const registry = [predecessor.registration];
  return { root, predecessor, registry };
}

afterEach(async () => {
  const active = children.splice(0);
  for (const child of active) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(active.map((child) => child.exited));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervised schema cutover with real processes", () => {
  it("keeps the successor before DB access until predecessor exit and returns only after readiness", async () => {
    const { root, predecessor, registry } = await setup();
    let successor: ReturnType<typeof daemon> | undefined;
    const events: string[] = [];
    const outcome = await performSupervisedDaemonRestart({
      list: () => registry.map((process) => ({ ...process })),
      start: ({ force }) => {
        expect(force).toBe(true);
        successor = daemon(root, "successor", 5);
        registry.push(successor.registration);
        events.push("spawn");
        return 0;
      },
      schemaPhase: (process) => {
        const phase = readDaemonSchemaPhase(process, root);
        if (process.pmId === 5 && (phase === "owned" || phase === "ready")) {
          // The lifetime lock is not released by any user-space teardown in
          // the fixture. This process can own it only after the predecessor
          // has actually exited, not merely after its registry entry changed.
          expect(alive(predecessor.child.pid)).toBe(false);
          events.push(phase);
        }
        return phase;
      },
      deletePmId: (pmId) => {
        expect(pmId).toBe(4);
        expect(successor).toBeDefined();
        expect(readDaemonSchemaPhase(successor!.registration, root)).toBe("waiting");
        expect(existsSync(join(root, "successor.owned"))).toBe(false);
        expect(existsSync(join(root, "successor.db"))).toBe(false);
        events.push("stop");
        predecessor.child.kill("SIGKILL");
        registry.splice(
          registry.findIndex((process) => process.pmId === pmId),
          1,
        );
        return 0;
      },
      save: () => {
        events.push("save");
        return 0;
      },
      pidAlive: alive,
      pollMs: 10,
      readyTimeoutMs: 5_000,
      confirmations: 2,
    });

    expect(outcome).toMatchObject({ ok: true, code: "restarted", predecessorPreserved: false, deletedPmIds: [4] });
    expect(successor).toBeDefined();
    expect(readDaemonSchemaPhase(successor!.registration, root)).toBe("ready");
    expect(existsSync(join(root, "successor.db"))).toBe(true);
    expect(existsSync(join(root, "successor.ready"))).toBe(true);
    expect(events.indexOf("save")).toBeLessThan(events.indexOf("stop"));
    expect(events.indexOf("ready")).toBeGreaterThan(events.indexOf("stop"));
    expect(events.lastIndexOf("save")).toBeGreaterThan(events.indexOf("ready"));
    expect(alive(predecessor.child.pid)).toBe(false);
  }, 15_000);

  it("leaves successor DB access blocked if stopping the predecessor fails", async () => {
    const { root, predecessor, registry } = await setup();
    let successor: ReturnType<typeof daemon> | undefined;
    const outcome = await performSupervisedDaemonRestart({
      list: () => registry.map((process) => ({ ...process })),
      start: () => {
        successor = daemon(root, "successor", 5);
        registry.push(successor.registration);
        return 0;
      },
      schemaPhase: (process) => readDaemonSchemaPhase(process, root),
      deletePmId: (pmId) => {
        expect(pmId).toBe(4);
        return 1;
      },
      save: () => 0,
      pidAlive: alive,
      pollMs: 10,
      readyTimeoutMs: 5_000,
      confirmations: 2,
    });

    expect(outcome).toMatchObject({ ok: false, code: "predecessor_stop_failed", predecessorPreserved: true });
    expect(successor).toBeDefined();
    expect(readDaemonSchemaPhase(successor!.registration, root)).toBe("waiting");
    expect(existsSync(join(root, "successor.db"))).toBe(false);
    expect(existsSync(join(root, "successor.owned"))).toBe(false);
    expect(alive(predecessor.child.pid)).toBe(true);
  }, 15_000);
});

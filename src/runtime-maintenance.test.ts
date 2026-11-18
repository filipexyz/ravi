import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  assertRuntimeMaintenanceInactive,
  assertRuntimeReplacementPrepared,
  assertThreadFenceBootstrapAuthorized,
  prepareRuntimeMaintenance,
  processExitState,
  readRuntimeMaintenance,
  runtimeReplacementReadiness,
  runtimeStartReadiness,
  type MaintenanceProcess,
  type ProcessCompletionEvidence,
} from "./runtime-maintenance.js";
import { resolveAccountHome } from "./utils/account-home.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-thread-maintenance-"));
  roots.push(stateDir);
  const predecessors: MaintenanceProcess[] = [
    { name: "ravi", pid: 101, startedAt: 1000, bundleSha256: "a".repeat(64) },
    { name: "ravi-channels", pid: 102, startedAt: 1001, bundleSha256: "a".repeat(64) },
  ];
  let current = [...predecessors];
  const exited = new Set<number>();
  const stopped: string[] = [];
  const queuePath = join(stateDir, "pending-outbound.json");
  writeFileSync(queuePath, JSON.stringify({ eventId: "event-1", destination: "slack-1", claim: "unchanged" }));
  const evidencePath = join(stateDir, "external-reviewed-completion.json");
  writeFileSync(evidencePath, "fixture evidence: inventory, accepted work persistence, completion, disabled launchers");
  const evidenceSha256 = createHash("sha256").update(readFileSync(evidencePath)).digest("hex");
  const input = {
    stateDir,
    predecessors,
    targetBundleSha256: "b".repeat(64),
    verifyCompletion: async (process: MaintenanceProcess): Promise<ProcessCompletionEvidence> => ({
      process,
      admissionsClosed: true,
      launcherDisabled: true,
      evidencePath,
      evidenceSha256,
    }),
    list: () => current,
    stop: async (process: MaintenanceProcess) => {
      stopped.push(process.name);
      current = current.filter((entry) => entry.pid !== process.pid);
      exited.add(process.pid);
    },
    exitState: (pid: number) => (exited.has(pid) ? ("exited" as const) : ("present" as const)),
    exitChecks: 2,
    wait: async () => {},
  };
  return {
    input,
    stateDir,
    stopped,
    predecessors,
    queuePath,
    evidencePath,
    replace: (value: MaintenanceProcess[]) => {
      current = value;
    },
  };
}

describe("runtime maintenance preparation", () => {
  it("blocks first installation before stopping anything without external full-work proof", async () => {
    const f = fixture();
    await expect(prepareRuntimeMaintenance({ ...f.input, verifyCompletion: undefined })).rejects.toThrow(
      "COMPLETION_PROOF_REQUIRED",
    );
    expect(f.stopped).toEqual([]);
    expect(readRuntimeMaintenance(f.stateDir)).toBeNull();
  });

  it("requires a complete starting inventory and distinct predecessor PIDs", async () => {
    const f = fixture();
    await expect(prepareRuntimeMaintenance({ ...f.input, list: () => [] })).rejects.toThrow("INVENTORY_UNPROVEN");
    await expect(
      prepareRuntimeMaintenance({
        ...f.input,
        predecessors: [f.predecessors[0]!, { ...f.predecessors[1]!, pid: 101 }],
      }),
    ).rejects.toThrow("IDENTITY_REQUIRED");
    expect(f.stopped).toEqual([]);
  });

  it("stops channels before daemon only after both verified completions; preserves pending work and interlock", async () => {
    const f = fixture();
    const pending = readFileSync(f.queuePath, "utf8");
    let proofs = 0;
    const result = await prepareRuntimeMaintenance({
      ...f.input,
      verifyCompletion: async (process) => {
        proofs += 1;
        return f.input.verifyCompletion(process);
      },
      stop: async (process) => {
        expect(proofs).toBe(2);
        await f.input.stop(process);
      },
    });
    expect(result.phase).toBe("stopped");
    expect(result.exitedPids).toEqual([102, 101]);
    expect(f.stopped).toEqual(["ravi-channels", "ravi"]);
    expect(readFileSync(f.queuePath, "utf8")).toBe(pending);
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("MAINTENANCE_ACTIVE");
  });

  it.each(["present", "unknown"] as const)("does not treat PM2 stop success as exit when PID is %s", async (state) => {
    const f = fixture();
    await expect(prepareRuntimeMaintenance({ ...f.input, exitState: () => state })).rejects.toThrow(
      "PROCESS_EXIT_UNPROVEN",
    );
    expect(f.stopped).toEqual(["ravi-channels"]);
    expect(readRuntimeMaintenance(f.stateDir)?.phase).toBe("blocked");
    expect(() => assertRuntimeMaintenanceInactive(f.stateDir)).toThrow("MAINTENANCE_ACTIVE");
  });

  it("refuses launcher/readiness evidence without external admission and accepted-work proof", async () => {
    const f = fixture();
    await expect(
      prepareRuntimeMaintenance({
        ...f.input,
        verifyCompletion: async (process) =>
          ({
            ...(await f.input.verifyCompletion(process)),
            launcherDisabled: false,
          }) as unknown as ProcessCompletionEvidence,
      }),
    ).rejects.toThrow("COMPLETION_UNPROVEN");
    expect(f.stopped).toEqual([]);
  });

  it("retains the interlock if a replacement appears", async () => {
    const f = fixture();
    await expect(
      prepareRuntimeMaintenance({
        ...f.input,
        stop: async (process) => {
          await f.input.stop(process);
          f.replace([...f.predecessors, { ...f.predecessors[1]!, pid: 103, startedAt: 2000 }]);
        },
      }),
    ).rejects.toThrow("REPLACEMENT_OBSERVED");
    expect(f.stopped).toEqual(["ravi-channels"]);
    expect(readRuntimeMaintenance(f.stateDir)?.phase).toBe("blocked");
  });

  it("keeps the initial process identities when caller metadata changes during verification", async () => {
    const f = fixture();
    const initial = f.predecessors.map((entry) => ({ ...entry }));
    await expect(
      prepareRuntimeMaintenance({
        ...f.input,
        verifyCompletion: async (predecessor) => {
          expect(Object.isFrozen(predecessor)).toBe(true);
          f.predecessors[0]!.pid = 9999;
          return f.input.verifyCompletion(predecessor);
        },
      }),
    ).rejects.toThrow("REPLACEMENT_OBSERVED");
    expect(f.stopped).toEqual([]);
    expect(readRuntimeMaintenance(f.stateDir)?.predecessors).toEqual(initial);
  });

  it("retains the interlock when inventory becomes unavailable instead of interpreting it as exit", async () => {
    const f = fixture();
    let reads = 0;
    await expect(
      prepareRuntimeMaintenance({
        ...f.input,
        list: () => {
          reads += 1;
          if (reads > 1) throw new Error("PM2_INVENTORY_UNAVAILABLE");
          return f.predecessors;
        },
      }),
    ).rejects.toThrow("PM2_INVENTORY_UNAVAILABLE");
    expect(f.stopped).toEqual([]);
    expect(readRuntimeMaintenance(f.stateDir)?.phase).toBe("blocked");
  });

  it("rejects stale identity or changed evidence before any stop", async () => {
    const f = fixture();
    await expect(
      prepareRuntimeMaintenance({
        ...f.input,
        verifyCompletion: async (process) => ({
          ...(await f.input.verifyCompletion(process)),
          process: { ...process, startedAt: process.startedAt + 1 },
        }),
      }),
    ).rejects.toThrow("COMPLETION_UNPROVEN");
    expect(f.stopped).toEqual([]);
  });

  it("accepts only ESRCH as physical exit; EPERM and other probe errors remain unknown", () => {
    const probe = (code: string) =>
      (() => {
        throw Object.assign(new Error(code), { code });
      }) as typeof process.kill;
    expect(processExitState(101, probe("ESRCH"))).toBe("exited");
    expect(processExitState(101, probe("EPERM"))).toBe("unknown");
    expect(processExitState(101, probe("EIO"))).toBe("unknown");
    expect(processExitState(101, (() => true) as typeof process.kill)).toBe("present");
    expect(processExitState(0, probe("ESRCH"))).toBe("unknown");
  });

  it("allows only empty isolated bootstrap; real and existing state need reviewed external authorization", () => {
    const f = fixture();
    expect(() =>
      assertThreadFenceBootstrapAuthorized({ existingSchema: false, databasePath: join(f.stateDir, "ravi.db") }),
    ).not.toThrow();
    expect(() =>
      assertThreadFenceBootstrapAuthorized({ existingSchema: true, databasePath: join(f.stateDir, "ravi.db") }),
    ).toThrow("BOOTSTRAP_BLOCKED");
    const home = resolveAccountHome();
    expect(home).not.toBeNull();
    expect(() =>
      assertThreadFenceBootstrapAuthorized({ existingSchema: false, databasePath: join(home!, ".ravi", "ravi.db") }),
    ).toThrow("BOOTSTRAP_BLOCKED");
  });

  it("a first start needs no preparation evidence; a replacement without a database still refuses", () => {
    const f = fixture();
    const path = join(f.stateDir, "ravi.db");
    expect(runtimeStartReadiness(f.stateDir)).toBe("fresh");
    expect(() => runtimeReplacementReadiness(f.stateDir)).toThrow("On a new installation, run 'ravi daemon start'");
    expect(() => assertRuntimeReplacementPrepared(f.stateDir)).toThrow("no preparation evidence");
    // The empty file a refused first start leaves is still a first start.
    writeFileSync(path, "");
    expect(runtimeStartReadiness(f.stateDir)).toBe("fresh");
    // A database a release wrote is not: the daemon adopts it at its entry.
    const db = new Database(path);
    db.exec("CREATE TABLE sentinel (value TEXT)");
    db.close();
    expect(runtimeStartReadiness(f.stateDir)).toBe("adopt-on-start");
  });

  it("refuses replacement on legacy schema without mutating its data or adding the fence", async () => {
    const f = fixture();
    const path = join(f.stateDir, "ravi.db");
    const db = new Database(path);
    db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('private existing work')");
    expect(() => assertRuntimeReplacementPrepared(f.stateDir)).toThrow("THREAD_SCHEMA_FENCED");
    expect(db.query("SELECT value FROM sentinel").get()).toEqual({ value: "private existing work" });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'thread_schema_fence'").get()).toBeNull();
    db.close();
  });
});

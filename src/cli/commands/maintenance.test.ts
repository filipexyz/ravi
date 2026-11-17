import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDatabase } from "../../db/state-boundary.js";
import { prepareThreadFence } from "../../threads/schema-fence.js";
import { getCommandsMetadata, getOptionsMetadata, getReturnsMetadata } from "../decorators.js";
import { MaintenanceCommands, startSuccessorAndWait } from "./maintenance.js";

let stateDir = "";
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.RAVI_STATE_DIR;
  stateDir = mkdtempSync(join(tmpdir(), "ravi-maintenance-cli-"));
  process.env.RAVI_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = previous;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("maintenance thread-fence-recover contract", () => {
  it("an unknown mode is a usage error (exit 2)", async () => {
    await expect(new MaintenanceCommands().recover("wipe", true, true)).rejects.toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
    });
  });

  it("without --execute it is a dry-run (exit 3) that shows the record and writes nothing", async () => {
    const error = (await new MaintenanceCommands().recover("release", false, true).catch((cause) => cause)) as {
      code: string;
      exitCode: number;
      details: { plan: { mode: string; state: { interlock: boolean; modes: string[]; diagnosis: string } } };
    };
    expect(error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(error.exitCode).toBe(3);
    expect(error.details.plan.mode).toBe("release");
    expect(error.details.plan.state.interlock).toBe(false);
    expect(error.details.plan.state.modes).toEqual([]);
    expect(error.details.plan.state.diagnosis).toBe("no maintenance is active");
  });

  it("channels start only after the interlock is gone, not when the adoption record disappears", async () => {
    const maintenance = join(stateDir, "runtime-maintenance");
    mkdirSync(join(maintenance, "interlock"), { recursive: true });
    const started: string[] = [];
    let ticks = 0;
    const result = await startSuccessorAndWait(stateDir, {
      start: (name) => {
        started.push(name);
        return 0;
      },
      wait: async () => {
        ticks += 1;
        // The successor installed the fence and moved its records, but the interlock is still there.
        expect(started).toEqual(["ravi"]);
        if (ticks === 2) {
          const db = openStateDatabase(join(stateDir, "ravi.db"));
          prepareThreadFence(db);
          db.close();
          rmSync(join(maintenance, "interlock"), { recursive: true });
        }
      },
      timeoutMs: 60_000,
    });
    expect(result).toEqual({ adopted: true, detail: "fence adopted, interlock released, channels started" });
    expect(started).toEqual(["ravi", "ravi-channels"]);
    expect(ticks).toBe(2);
  });

  it("a domain refusal keeps its code and exits 1", async () => {
    await expect(new MaintenanceCommands().recover("abandon", true, true)).rejects.toMatchObject({
      code: "THREAD_FENCE_ADOPTION_BLOCKED",
      exitCode: 1,
    });
  });
});

describe("maintenance command metadata", () => {
  it("declares --json and a return shape on both commands", () => {
    const commands = getCommandsMetadata(MaintenanceCommands);
    const returns = getReturnsMetadata(MaintenanceCommands);
    expect(commands.map((entry) => entry.name).sort()).toEqual(["thread-fence-adopt", "thread-fence-recover"]);
    for (const command of commands) {
      expect(returns.get(command.method)).toBeDefined();
      const options = getOptionsMetadata(MaintenanceCommands.prototype, command.method);
      expect(options.some((option) => option.flags === "--json")).toBe(true);
    }
  });
});

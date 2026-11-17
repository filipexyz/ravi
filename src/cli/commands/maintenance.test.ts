import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCommandsMetadata, getOptionsMetadata, getReturnsMetadata } from "../decorators.js";
import { MaintenanceCommands } from "./maintenance.js";

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
    await expect(new MaintenanceCommands().recover("release", false, true)).rejects.toMatchObject({
      code: "WRITE_REQUIRES_EXECUTE",
      exitCode: 3,
      details: { plan: { mode: "release", adoption: null } },
    });
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

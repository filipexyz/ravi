import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveBootIdentity } from "./fence-adoption-live.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateWithReceipt(receipt: Record<string, unknown>): string {
  const stateDir = mkdtempSync(join(tmpdir(), "ravi-fence-adoption-live-"));
  roots.push(stateDir);
  mkdirSync(join(stateDir, "runtime-processes"));
  writeFileSync(join(stateDir, "runtime-processes", `${receipt.name}.json`), JSON.stringify(receipt));
  return stateDir;
}

// Shape written by recordManagedRuntimeBoot in 3.261113.2 (schemaVersion 1).
const legacyReceipt = {
  schemaVersion: 1,
  name: "ravi-channels",
  pid: 4242,
  startedAt: 1_700_000_000_000,
  runningVersion: "3.261113.2",
  bundlePath: "/opt/ravi/dist/bundle/index.js",
  bundle: { mtimeMs: 1, size: 10, ino: 7, sha256: "c".repeat(64) },
  envFile: "/opt/ravi/.env",
  env: null,
  capturedAt: 1_700_000_000_500,
};
const registration = {
  name: "ravi-channels",
  pid: 4242,
  startedAt: 1_700_000_000_000,
  online: true,
  scriptPath: "/opt/ravi/dist/bundle/index.js",
};

describe("live legacy boot identity", () => {
  it("reads the legacy receipt matched by pid and start time", () => {
    const stateDir = stateWithReceipt(legacyReceipt);
    expect(liveBootIdentity(registration, stateDir)).toEqual({
      name: "ravi-channels",
      pid: 4242,
      startedAt: 1_700_000_000_000,
      bundleSha256: "c".repeat(64),
    });
  });

  it("a receipt from another incarnation or without a certified bundle proves nothing", () => {
    const stateDir = stateWithReceipt(legacyReceipt);
    expect(liveBootIdentity({ ...registration, startedAt: 1_700_000_000_001 }, stateDir)).toBeNull();
    expect(liveBootIdentity({ ...registration, pid: 4243 }, stateDir)).toBeNull();
    expect(liveBootIdentity({ ...registration, name: "nats" }, stateDir)).toBeNull();
    const uncertified = stateWithReceipt({ ...legacyReceipt, bundle: null });
    expect(liveBootIdentity(registration, uncertified)).toBeNull();
  });
});

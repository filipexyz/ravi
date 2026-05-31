import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { SyncCommands } from "./sync.js";

let stateDir: string;
let originalSyncRunnerEnabled: string | undefined;

beforeEach(async () => {
  originalSyncRunnerEnabled = process.env.RAVI_SYNC_RUNNER_ENABLED;
  delete process.env.RAVI_SYNC_RUNNER_ENABLED;
  stateDir = await createIsolatedRaviState("ravi-sync-cli-test-");
});

afterEach(async () => {
  if (originalSyncRunnerEnabled === undefined) delete process.env.RAVI_SYNC_RUNNER_ENABLED;
  else process.env.RAVI_SYNC_RUNNER_ENABLED = originalSyncRunnerEnabled;
  await cleanupIsolatedRaviState(stateDir);
});

describe("sync cli", () => {
  it("prints status as JSON", () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    try {
      const result = new SyncCommands().status(true);
      expect(result.linked).toBe(false);
      const parsed = JSON.parse(logs.join("\n")) as {
        linked: boolean;
        runner: { enabled: boolean; env: string };
        outbox: { pending: number };
      };
      expect(parsed.linked).toBe(false);
      expect(parsed.runner).toMatchObject({ enabled: false, env: "RAVI_SYNC_RUNNER_ENABLED" });
      expect(parsed.outbox.pending).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

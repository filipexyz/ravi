import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { SyncCommands } from "./sync.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sync-cli-test-");
});

afterEach(async () => {
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
      const parsed = JSON.parse(logs.join("\n")) as { linked: boolean; outbox: { pending: number } };
      expect(parsed.linked).toBe(false);
      expect(parsed.outbox.pending).toBe(0);
    } finally {
      log.mockRestore();
    }
  });
});

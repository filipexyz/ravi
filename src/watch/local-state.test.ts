import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalWatchSnapshot } from "./local-events.js";
import {
  clearLocalWatchSnapshot,
  localWatchSnapshotPath,
  readLocalWatchSnapshot,
  writeLocalWatchSnapshot,
} from "./local-state.js";

function snapshot(): LocalWatchSnapshot {
  return { version: 1, pullRequests: {}, workflowRuns: {} };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ravi-local-state-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("local watch state", () => {
  it("round-trips a snapshot", () => {
    withTempDir((dir) => {
      writeLocalWatchSnapshot("watch_1", snapshot(), dir);
      expect(readLocalWatchSnapshot("watch_1", dir)).toEqual(snapshot());
    });
  });

  it("returns null for a watch with no state", () => {
    withTempDir((dir) => {
      expect(readLocalWatchSnapshot("watch_missing", dir)).toBeNull();
    });
  });

  it("returns null for a corrupt snapshot instead of throwing", () => {
    withTempDir((dir) => {
      writeLocalWatchSnapshot("watch_1", snapshot(), dir);
      writeFileSync(localWatchSnapshotPath("watch_1", dir), "{ truncado");
      expect(readLocalWatchSnapshot("watch_1", dir)).toBeNull();
    });
  });

  it("leaves no temp file behind after writing", () => {
    withTempDir((dir) => {
      writeLocalWatchSnapshot("watch_1", snapshot(), dir);
      // Escrita por tmp + rename: um .tmp sobrevivendo seria lixo acumulando.
      expect(readdirSync(join(dir, "watch-local"))).toEqual(["watch_1.json"]);
    });
  });

  it("clears the snapshot and is idempotent", () => {
    withTempDir((dir) => {
      writeLocalWatchSnapshot("watch_1", snapshot(), dir);
      expect(clearLocalWatchSnapshot("watch_1", dir)).toBe(true);
      expect(readLocalWatchSnapshot("watch_1", dir)).toBeNull();
      // Apagar duas vezes não é erro.
      expect(clearLocalWatchSnapshot("watch_1", dir)).toBe(false);
    });
  });
});

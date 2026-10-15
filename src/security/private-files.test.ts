import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrivateFileIfMissing,
  ensurePrivateFile,
  ensurePrivateSqliteFiles,
  preparePrivateSqliteFile,
} from "./private-files.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-private-files-"));
  tempDirs.push(dir);
  return dir;
}

function fileWithMode(mode: number, name = "ravi.db"): string {
  const path = join(tempDir(), name);
  writeFileSync(path, "data");
  chmodSync(path, mode);
  return path;
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("ensurePrivateFile", () => {
  posixOnly("tightens a 0644 file to 0600", () => {
    const path = fileWithMode(0o644);
    expect(ensurePrivateFile(path)).toEqual({ path, action: "tightened", previousMode: "0644", mode: "0600" });
    expect(modeOf(path)).toBe(0o600);
  });

  posixOnly("keeps owner bits and strips group/other ones (0664 → 0600, 0444 → 0400)", () => {
    const groupWritable = fileWithMode(0o664);
    const readOnly = fileWithMode(0o444, "ro.db");
    ensurePrivateFile(groupWritable);
    ensurePrivateFile(readOnly);
    expect(modeOf(groupWritable)).toBe(0o600);
    expect(modeOf(readOnly)).toBe(0o400);
  });

  posixOnly("leaves an already private file alone", () => {
    const path = fileWithMode(0o600);
    let chmodCalls = 0;
    const result = ensurePrivateFile(path, { chmod: () => chmodCalls++ });
    expect(result.action).toBe("already_private");
    expect(chmodCalls).toBe(0);
  });

  posixOnly("never follows a symlink, and leaves its target unchanged", () => {
    const target = fileWithMode(0o644, "target.db");
    const link = join(tempDir(), "ravi.db");
    symlinkSync(target, link);
    expect(ensurePrivateFile(link).action).toBe("symlink");
    expect(modeOf(target)).toBe(0o644);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  posixOnly("skips a file owned by another user", () => {
    const path = fileWithMode(0o644);
    const foreignUid = (statSync(path).uid + 1) >>> 0;
    expect(ensurePrivateFile(path, { getuid: () => foreignUid }).action).toBe("not_owner");
    expect(modeOf(path)).toBe(0o644);
  });

  posixOnly("skips anything that is not a regular file", () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    expect(ensurePrivateFile(dir).action).toBe("not_file");
    expect(modeOf(dir)).toBe(0o755);
  });

  posixOnly("honours RAVI_STATE_DIR_KEEP_PERMISSIONS=1", () => {
    const path = fileWithMode(0o644);
    expect(ensurePrivateFile(path, { env: { RAVI_STATE_DIR_KEEP_PERMISSIONS: "1" } }).action).toBe("opted_out");
    expect(modeOf(path)).toBe(0o644);
  });

  it("reports a missing file without creating it", () => {
    const path = join(tempDir(), "missing.db");
    expect(ensurePrivateFile(path)).toMatchObject({ action: "missing", previousMode: null });
    expect(() => statSync(path)).toThrow();
  });

  posixOnly("never throws when chmod fails", () => {
    const path = fileWithMode(0o644);
    const result = ensurePrivateFile(path, {
      chmod: () => {
        throw new Error("EPERM");
      },
    });
    expect(result).toMatchObject({ action: "error", error: "EPERM", previousMode: "0644" });
  });

  posixOnly("refuses when the path was swapped for another file after inspection", () => {
    const path = fileWithMode(0o644);
    const inspected = lstatSync(path);
    rmSync(path);
    writeFileSync(path, "replacement");
    chmodSync(path, 0o644);
    // Reuse the real no-follow chmod with the stale inspection result.
    const result = ensurePrivateFile(path, { lstat: () => inspected });
    if (lstatSync(path).ino === inspected.ino) return; // the filesystem reused the inode; nothing to prove
    expect(result.action).toBe("error");
    expect(modeOf(path)).toBe(0o644);
  });

  it("is unsupported on win32", () => {
    expect(ensurePrivateFile("C:\\ravi\\ravi.db", { platform: "win32" }).action).toBe("unsupported");
  });
});

describe("ensurePrivateSqliteFiles", () => {
  posixOnly("tightens the db, -wal and -shm of a live WAL database", () => {
    const dbPath = join(tempDir(), "ravi.db");
    const db = new Database(dbPath);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) chmodSync(path, 0o644);

      const results = ensurePrivateSqliteFiles(dbPath);

      expect(results.map((result) => result.action)).toEqual(["tightened", "tightened", "tightened"]);
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) expect(modeOf(path)).toBe(0o600);
      db.exec("INSERT INTO t VALUES (2);");
      expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });

  posixOnly("reports missing -wal/-shm without failing", () => {
    const dbPath = fileWithMode(0o644);
    expect(ensurePrivateSqliteFiles(dbPath).map((result) => result.action)).toEqual([
      "tightened",
      "missing",
      "missing",
    ]);
  });
});

describe("createPrivateFileIfMissing / preparePrivateSqliteFile", () => {
  posixOnly("creates a missing db file 0600 whatever the umask", () => {
    const path = join(tempDir(), "ravi.db");
    const previousUmask = process.umask(0o022);
    try {
      expect(createPrivateFileIfMissing(path)).toBe("created");
    } finally {
      process.umask(previousUmask);
    }
    expect(modeOf(path)).toBe(0o600);
    expect(statSync(path).size).toBe(0);
  });

  posixOnly("leaves an existing file, a symlink and relative or :memory: paths alone", () => {
    const existing = fileWithMode(0o644);
    expect(createPrivateFileIfMissing(existing)).toBe("exists");
    expect(modeOf(existing)).toBe(0o644);

    const target = join(tempDir(), "elsewhere.db");
    const link = join(tempDir(), "linked.db");
    symlinkSync(target, link);
    expect(createPrivateFileIfMissing(link)).toBe("exists");
    expect(() => statSync(target)).toThrow();

    expect(createPrivateFileIfMissing(":memory:")).toBe("skipped");
    expect(createPrivateFileIfMissing("relative.db")).toBe("skipped");
  });

  posixOnly("a WAL database opened after prepare is 0600 with its -wal/-shm, with no chmod afterwards", () => {
    const dbPath = join(tempDir(), "ravi.db");
    const previousUmask = process.umask(0o022);
    const db = (() => {
      try {
        preparePrivateSqliteFile(dbPath);
        const opened = new Database(dbPath);
        opened.exec("PRAGMA journal_mode = WAL");
        opened.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);");
        return opened;
      } finally {
        process.umask(previousUmask);
      }
    })();
    try {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) expect(modeOf(path)).toBe(0o600);
      expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  posixOnly("honours RAVI_STATE_DIR_KEEP_PERMISSIONS=1 for new files too", () => {
    const dbPath = join(tempDir(), "ravi.db");
    preparePrivateSqliteFile(dbPath, { env: { RAVI_STATE_DIR_KEEP_PERMISSIONS: "1" } });
    expect(() => statSync(dbPath)).toThrow();
  });
});

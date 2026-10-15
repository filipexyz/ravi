import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStateDirPermissions, tightenStateDirPermissions } from "./state-dir-permissions.js";

const tempDirs: string[] = [];

function makeStateDir(mode: number): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-state-perms-"));
  tempDirs.push(root);
  const dir = join(root, ".ravi");
  mkdirSync(dir);
  chmodSync(dir, mode);
  return dir;
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

describe("inspectStateDirPermissions", () => {
  posixOnly("reports group/other access on a 0755 dir", () => {
    const dir = makeStateDir(0o755);
    const inspection = inspectStateDirPermissions(dir);
    expect(inspection).toMatchObject({
      exists: true,
      isDirectory: true,
      isSymlink: false,
      ownedByCurrentUser: true,
      mode: 0o755,
      modeOctal: "0755",
      groupOrOtherAccess: true,
    });
  });

  posixOnly("reports a private 0700 dir as clean", () => {
    const dir = makeStateDir(0o700);
    expect(inspectStateDirPermissions(dir)).toMatchObject({ modeOctal: "0700", groupOrOtherAccess: false });
  });

  it("reports a missing dir without throwing", () => {
    const inspection = inspectStateDirPermissions(join(tmpdir(), "ravi-state-perms-does-not-exist", ".ravi"));
    expect(inspection.exists).toBe(false);
    expect(inspection.error).toBeUndefined();
  });

  it("is unsupported on win32", () => {
    expect(inspectStateDirPermissions("C:\\ravi", { platform: "win32" }).supported).toBe(false);
  });
});

describe("tightenStateDirPermissions", () => {
  posixOnly("chmods an owned 0755 dir to 0700", () => {
    const dir = makeStateDir(0o755);
    const result = tightenStateDirPermissions(dir);
    expect(result).toEqual({ path: dir, action: "tightened", previousMode: "0755", mode: "0700" });
    expect(modeOf(dir)).toBe(0o700);
  });

  posixOnly("leaves an already private dir untouched", () => {
    const dir = makeStateDir(0o700);
    let chmodCalls = 0;
    const result = tightenStateDirPermissions(dir, { chmod: () => chmodCalls++ });
    expect(result.action).toBe("already_private");
    expect(chmodCalls).toBe(0);
  });

  posixOnly("never chmods a dir owned by someone else", () => {
    const dir = makeStateDir(0o755);
    let chmodCalls = 0;
    const result = tightenStateDirPermissions(dir, {
      getuid: () => (process.getuid?.() ?? 0) + 1,
      chmod: () => chmodCalls++,
    });
    expect(result.action).toBe("not_owner");
    expect(chmodCalls).toBe(0);
    expect(modeOf(dir)).toBe(0o755);
  });

  posixOnly("never follows a symlinked state dir", () => {
    const target = makeStateDir(0o755);
    const link = join(target, "..", "link-ravi");
    symlinkSync(target, link);
    const result = tightenStateDirPermissions(link);
    expect(result.action).toBe("symlink");
    expect(modeOf(target)).toBe(0o755);
    expect(inspectStateDirPermissions(link)).toMatchObject({ isSymlink: true, groupOrOtherAccess: true });
  });

  posixOnly("refuses a non-directory path", () => {
    const dir = makeStateDir(0o700);
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x", { mode: 0o644 });
    expect(tightenStateDirPermissions(file).action).toBe("not_directory");
    expect(modeOf(file)).toBe(0o644);
  });

  posixOnly("leaves the home directory, setgid shared dirs and opted-out dirs alone", () => {
    const home = makeStateDir(0o755);
    expect(tightenStateDirPermissions(home, { homedir: () => home }).action).toBe("home_dir");
    expect(modeOf(home)).toBe(0o755);

    // A real chmod 0o2770 may silently drop setgid (group membership, runtime),
    // so the setgid dir is described through fake stats instead.
    const shared = makeStateDir(0o770);
    const sharedStats = Object.assign(Object.create(statSync(shared)), { mode: 0o42770 });
    let sharedChmods = 0;
    const sharedResult = tightenStateDirPermissions(shared, {
      lstat: () => sharedStats,
      chmod: () => sharedChmods++,
    });
    expect(sharedResult.action).toBe("shared_group");
    expect(sharedChmods).toBe(0);

    const optedOut = makeStateDir(0o755);
    const result = tightenStateDirPermissions(optedOut, { env: { RAVI_STATE_DIR_KEEP_PERMISSIONS: "1" } });
    expect(result.action).toBe("opted_out");
    expect(modeOf(optedOut)).toBe(0o755);
  });

  it("reports missing, unsupported and chmod errors without throwing", () => {
    expect(tightenStateDirPermissions(join(tmpdir(), "ravi-state-perms-missing", ".ravi")).action).toBe("missing");
    expect(tightenStateDirPermissions("C:\\ravi", { platform: "win32" }).action).toBe("unsupported");
    if (process.platform !== "win32") {
      const dir = makeStateDir(0o755);
      const result = tightenStateDirPermissions(dir, {
        chmod: () => {
          throw new Error("EPERM");
        },
      });
      expect(result).toMatchObject({ action: "error", error: "EPERM" });
    }
  });
});

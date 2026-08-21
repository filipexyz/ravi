import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  captureNativeSpecsTree,
  createNativeSpec,
  NativeSpecsSafetyError,
  nativeSpecsImplementation,
} from "./native-safe-fs.js";

const tempRoots: string[] = [];
const openat2RollbackChildFlag = "--ravi-test-openat2-rollback-child";

setDefaultTimeout(20_000);

function runOpenat2RollbackChild(): void {
  const flagIndex = process.argv.indexOf(openat2RollbackChildFlag);
  if (flagIndex < 0) return;
  const cwd = process.argv[flagIndex + 1];
  if (!cwd) process.exit(10);
  const snapshot = captureNativeSpecsTree(cwd);
  const stagingPath = join(cwd, ".ravi", "specs", ".channels.ravi-stage-openat2");
  try {
    createNativeSpec({
      workspacePath: cwd,
      expectedWorkspaceIdentity: snapshot.workspaceIdentity,
      expectedRootBinding: snapshot.rootBinding,
      targetSegments: ["channels"],
      files: [{ name: "SPEC.md", content: "safe payload" }],
      requireAncestors: false,
      existing: "error",
      existingDirectory: "error",
      stagingName: ".channels.ravi-stage-openat2",
      stagingPath,
      originalRecoveryPath: `${stagingPath}.original`,
    });
    process.exit(11);
  } catch (error) {
    process.exit(error instanceof NativeSpecsSafetyError ? 0 : 12);
  }
}

runOpenat2RollbackChild();

function makeWorkspace(prefix = "ravi-specs-native-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createDirectoryLink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
    throw error;
  }
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("specs native safe filesystem", () => {
  it("loads the same Node-API addon in Bun and Node", () => {
    const cwd = makeWorkspace();
    const spec = join(cwd, ".ravi", "specs", "channels", "SPEC.md");
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(spec, "native payload", "utf8");

    expect(nativeSpecsImplementation()).toBe("node-api-handles-v2");
    expect(
      captureNativeSpecsTree(cwd).entries.find((entry) => entry.relativePath === "channels/SPEC.md")?.content,
    ).toBe("native payload");

    const addon = resolve(
      import.meta.dir,
      "../../native/prebuilds",
      `${process.platform}-${process.arch}`,
      "ravi_specs_safe_fs.node",
    );
    const child = spawnSync(
      "node",
      [
        "-e",
        "const addon=require(process.argv[1]);const value=addon.snapshot(process.argv[2]);if(addon.implementation!=='node-api-handles-v2'||value.entries[1]?.content!=='native payload')process.exit(9)",
        addon,
        cwd,
      ],
      { encoding: "utf8" },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  });

  it("rejects a deep unrelated directory replaced by a link between enumeration and open", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace("ravi-specs-native-outside-");
    const branch = join(cwd, ".ravi", "specs", "ignored", "deep", "branch");
    mkdirSync(branch, { recursive: true });
    writeFileSync(join(branch, "local.txt"), "local", "utf8");
    writeFileSync(join(outside, "SPEC.md"), "outside secret", "utf8");
    let linked = false;

    expect(() =>
      captureNativeSpecsTree(cwd, (relativePath) => {
        if (relativePath !== "ignored/deep/branch") return;
        rmSync(branch, { recursive: true });
        linked = createDirectoryLink(outside, branch);
      }),
    ).toThrow(NativeSpecsSafetyError);

    if (!linked) return;
    expect(readFileSync(join(outside, "SPEC.md"), "utf8")).toBe("outside secret");
  });

  it("rejects spec and companion files replaced between enumeration and open", () => {
    for (const fileName of ["SPEC.md", "WHY.md"]) {
      const cwd = makeWorkspace();
      const outside = makeWorkspace("ravi-specs-native-file-");
      const domain = join(cwd, ".ravi", "specs", "channels");
      const target = join(domain, fileName);
      const outsideFile = join(outside, `${fileName}.outside`);
      mkdirSync(domain, { recursive: true });
      writeFileSync(target, "local", "utf8");
      writeFileSync(outsideFile, "outside secret", "utf8");

      expect(() =>
        captureNativeSpecsTree(cwd, (relativePath) => {
          if (relativePath !== `channels/${fileName}`) return;
          rmSync(target);
          try {
            symlinkSync(outsideFile, target, "file");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
            linkSync(outsideFile, target);
          }
        }),
      ).toThrow(NativeSpecsSafetyError);

      expect(readFileSync(outsideFile, "utf8")).toBe("outside secret");
    }
  });

  it("rejects a target junction introduced immediately before native promotion", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace("ravi-specs-native-target-");
    const snapshot = captureNativeSpecsTree(cwd);
    const target = join(cwd, ".ravi", "specs", "channels");
    let linked = false;

    expect(() =>
      createNativeSpec({
        workspacePath: cwd,
        expectedWorkspaceIdentity: snapshot.workspaceIdentity,
        expectedRootBinding: snapshot.rootBinding,
        targetSegments: ["channels"],
        files: [{ name: "SPEC.md", content: "safe payload" }],
        requireAncestors: false,
        existing: "error",
        existingDirectory: "error",
        stagingName: ".channels.ravi-stage-native-link",
        stagingPath: join(cwd, ".ravi", "specs", ".channels.ravi-stage-native-link"),
        originalRecoveryPath: join(cwd, ".ravi", "specs", ".channels.ravi-stage-native-link.original"),
        beforePromote: () => {
          linked = createDirectoryLink(outside, target);
          return true;
        },
      }),
    ).toThrow(NativeSpecsSafetyError);

    if (!linked) return;
    expect(existsSync(join(outside, "SPEC.md"))).toBe(false);
    expect(readdirSync(join(cwd, ".ravi", "specs")).some((name) => name.includes("ravi-stage"))).toBe(false);
  });

  it("rejects modified private staging contents and removes the incomplete directory", () => {
    const cwd = makeWorkspace();
    const snapshot = captureNativeSpecsTree(cwd);
    const stagingPath = join(cwd, ".ravi", "specs", ".channels.ravi-stage-native-tamper");

    expect(() =>
      createNativeSpec({
        workspacePath: cwd,
        expectedWorkspaceIdentity: snapshot.workspaceIdentity,
        expectedRootBinding: snapshot.rootBinding,
        targetSegments: ["channels"],
        files: [{ name: "SPEC.md", content: "safe payload" }],
        requireAncestors: false,
        existing: "error",
        existingDirectory: "error",
        stagingName: ".channels.ravi-stage-native-tamper",
        stagingPath,
        originalRecoveryPath: `${stagingPath}.original`,
        beforePromote: (path) => {
          writeFileSync(join(path, "EXTRA.md"), "tampered", "utf8");
          return true;
        },
      }),
    ).toThrow(NativeSpecsSafetyError);

    expect(existsSync(join(cwd, ".ravi", "specs", "channels"))).toBe(false);
    expect(existsSync(stagingPath)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "removes a substituted stage from the public target after the final identity check",
    () => {
      const cwd = makeWorkspace();
      const snapshot = captureNativeSpecsTree(cwd);
      const specsRoot = join(cwd, ".ravi", "specs");
      const stagingPath = join(specsRoot, ".channels.ravi-stage-native-final-swap");
      const originalRecoveryPath = `${stagingPath}.original`;
      const rollbackPath = `${stagingPath}.rollback`;
      const targetPath = join(specsRoot, "channels");

      try {
        createNativeSpec({
          workspacePath: cwd,
          expectedWorkspaceIdentity: snapshot.workspaceIdentity,
          expectedRootBinding: snapshot.rootBinding,
          targetSegments: ["channels"],
          files: [{ name: "SPEC.md", content: "safe payload" }],
          requireAncestors: false,
          existing: "error",
          existingDirectory: "error",
          stagingName: ".channels.ravi-stage-native-final-swap",
          stagingPath,
          originalRecoveryPath,
          beforeNativePromote: (path, recoveryPath) => {
            renameSync(path, recoveryPath);
            mkdirSync(path);
            writeFileSync(join(path, "SPEC.md"), "substituted payload", "utf8");
            return true;
          },
        });
        throw new Error("Expected final staging substitution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(NativeSpecsSafetyError);
        expect((error as NativeSpecsSafetyError).code).toBe("PROMOTION_IDENTITY_CHANGED");
      }

      expect(existsSync(targetPath)).toBe(false);
      expect(existsSync(originalRecoveryPath)).toBe(false);
      expect(readFileSync(join(rollbackPath, "SPEC.md"), "utf8")).toBe("substituted payload");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rolls back directories created before a forced openat2 availability failure",
    () => {
      for (const precreateRavi of [false, true]) {
        const cwd = makeWorkspace();
        if (precreateRavi) mkdirSync(join(cwd, ".ravi"));
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), openat2RollbackChildFlag, cwd], {
          encoding: "utf8",
          env: { ...process.env, RAVI_TEST_ONLY_FORCE_OPENAT2_ENOSYS_AFTER_MKDIR: "specs" },
        });
        expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
        expect(existsSync(join(cwd, ".ravi", "specs"))).toBe(false);
        expect(existsSync(join(cwd, ".ravi"))).toBe(precreateRavi);
      }
    },
  );
});

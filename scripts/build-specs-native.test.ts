import { expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "..");
const scratchRoot = join(projectRoot, ".tmp");
const addonName = "ravi_specs_safe_fs.node";

setDefaultTimeout(240_000);

function prepareBuildRoot(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "native"), { recursive: true });
  copyFileSync(join(projectRoot, "scripts", "build-specs-native.ts"), join(root, "scripts", "build-specs-native.ts"));
  cpSync(join(projectRoot, "native", "specs-safe-fs"), join(root, "native", "specs-safe-fs"), {
    recursive: true,
  });
  return root;
}

function buildAll(root: string): void {
  const result = spawnSync(process.execPath, [join(root, "scripts", "build-specs-native.ts"), "all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Native reproducibility build failed with exit ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pathSpellings(path: string): Buffer[] {
  const resolved = resolve(path);
  const values = new Set([
    resolved,
    resolved.replaceAll("\\", "/"),
    resolved.toLowerCase(),
    resolved.replaceAll("\\", "/").toLowerCase(),
  ]);
  return [...values].flatMap((value) => [Buffer.from(value, "utf8"), Buffer.from(value, "utf16le")]);
}

it("builds path-independent native specs addons in two physical roots", () => {
  mkdirSync(scratchRoot, { recursive: true });
  const parent = mkdtempSync(join(scratchRoot, "specs-native-repro-"));
  try {
    const firstRoot = prepareBuildRoot(parent, "physical-root-a");
    const secondRoot = prepareBuildRoot(parent, "different-physical-root-b");
    buildAll(firstRoot);
    buildAll(secondRoot);

    for (const platform of ["linux", "win32"] as const) {
      const relativeAddon = join("native", "prebuilds", `${platform}-x64`, addonName);
      const first = readFileSync(join(firstRoot, relativeAddon));
      const second = readFileSync(join(secondRoot, relativeAddon));
      const forbiddenPaths = [firstRoot, secondRoot, projectRoot].flatMap(pathSpellings);

      for (const forbiddenPath of forbiddenPaths) {
        expect(first.indexOf(forbiddenPath)).toBe(-1);
        expect(second.indexOf(forbiddenPath)).toBe(-1);
      }
      expect(hash(first)).toBe(hash(second));
      expect(first).toEqual(second);
    }

    const workspace = join(parent, "addon-workspace");
    const specPath = join(workspace, ".ravi", "specs", "channels", "SPEC.md");
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, "path-independent payload", "utf8");
    const addonPath = join(firstRoot, "native", "prebuilds", `${process.platform}-x64`, addonName);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "const addon=require(process.argv[1]);const value=addon.snapshot(process.argv[2]);if(addon.implementation!=='node-api-handles-v2'||value.entries.find((entry)=>entry.relativePath==='channels/SPEC.md')?.content!=='path-independent payload')process.exit(9)",
        addonPath,
        workspace,
      ],
      { encoding: "utf8" },
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

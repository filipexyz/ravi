import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertBundleMapBinding,
  assertExactTarballEntries,
  assertMappedSourcesMatchCheckout,
  assertPackageFilesMatchCheckout,
  EXPECTED_PACKAGE_FILES,
} from "./consolidated-release-check.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createMatchingPackage(): { files: Map<string, string>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ravi-consolidated-gate-"));
  temporaryRoots.push(root);
  const files = new Map<string, string>();
  for (const relativePath of EXPECTED_PACKAGE_FILES) {
    const content = `fixture:${relativePath}`;
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    files.set(relativePath, content);
  }
  return { files, root };
}

describe("consolidated release artifact gate", () => {
  it("binds every packaged byte to the built checkout", () => {
    const { files, root } = createMatchingPackage();

    expect(assertPackageFilesMatchCheckout(files, root)).toMatch(/^[a-f0-9]{64}$/);

    files.set("bin/ravi", `${files.get("bin/ravi")}\n# tampered`);
    expect(() => assertPackageFilesMatchCheckout(files, root)).toThrow(
      "artifact release file diverges from checkout: bin/ravi",
    );

    const wrongHashes = Object.fromEntries(EXPECTED_PACKAGE_FILES.map((path) => [path, "0".repeat(64)]));
    files.set("bin/ravi", "fixture:bin/ravi");
    expect(() => assertPackageFilesMatchCheckout(files, root, wrongHashes)).toThrow(
      "package file SHA-256 mismatch for README.md",
    );
  });

  it("rejects missing and extra tarball entries", () => {
    const exact = EXPECTED_PACKAGE_FILES.map((path) => `package/${path}`);
    expect(() => assertExactTarballEntries(exact)).not.toThrow();
    expect(() => assertExactTarballEntries(exact.slice(1))).toThrow("missing=package/README.md");
    expect(() => assertExactTarballEntries([...exact, "package/unexpected.js"])).toThrow(
      "unexpected=package/unexpected.js",
    );
  });

  it("binds the bundle to the exact source map identity", () => {
    const debugId = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const bundle = `console.log("fixture");\n//# debugId=${debugId}\n//# sourceMappingURL=index.js.map\n`;

    expect(() => assertBundleMapBinding(bundle, debugId, debugId)).not.toThrow();
    expect(() => assertBundleMapBinding(bundle, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", debugId)).toThrow(
      "bundle/source map debugId mismatch",
    );
  });

  it("rejects a source map copied from a divergent checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "ravi-consolidated-sources-"));
    temporaryRoots.push(root);
    const sourcePath = join(root, "src/feature.ts");
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "export const fixture = true;\n");
    const sourceMap = {
      sources: ["../../src/feature.ts"],
      sourcesContent: ["export const fixture = true;\n"],
    };

    expect(() => assertMappedSourcesMatchCheckout(sourceMap, root)).not.toThrow();
    writeFileSync(sourcePath, "export const fixture = false;\n");
    expect(() => assertMappedSourcesMatchCheckout(sourceMap, root)).toThrow(
      "mapped source diverges from checkout: src/feature.ts",
    );
  });
});

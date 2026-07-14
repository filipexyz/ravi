import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertExactTarballEntries,
  assertPackageFilesMatchCheckout,
  EXPECTED_PACKAGE_FILES,
} from "./check-consolidated-release.js";

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
  });

  it("rejects missing and extra tarball entries", () => {
    const exact = EXPECTED_PACKAGE_FILES.map((path) => `package/${path}`);
    expect(() => assertExactTarballEntries(exact)).not.toThrow();
    expect(() => assertExactTarballEntries(exact.slice(1))).toThrow("missing=package/README.md");
    expect(() => assertExactTarballEntries([...exact, "package/unexpected.js"])).toThrow(
      "unexpected=package/unexpected.js",
    );
  });
});

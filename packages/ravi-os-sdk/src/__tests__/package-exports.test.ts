import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

interface PackageExportTarget {
  types: string;
  default: string;
}

interface SdkPackageJson {
  exports: Record<string, PackageExportTarget>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as SdkPackageJson;

describe("SDK package exports", () => {
  it("maps every advertised JavaScript and type entry to a source module", () => {
    for (const [subpath, target] of Object.entries(packageJson.exports)) {
      const javascriptSource = sourcePathForDistTarget(target.default, ".js");
      const typeSource = sourcePathForDistTarget(target.types, ".d.ts");

      expect(existsSync(resolve(packageRoot, javascriptSource)), `${subpath} default export`).toBe(true);
      expect(existsSync(resolve(packageRoot, typeSource)), `${subpath} type export`).toBe(true);
    }
  });
});

function sourcePathForDistTarget(target: string, suffix: ".js" | ".d.ts"): string {
  expect(target.startsWith("./dist/"), `unexpected package target: ${target}`).toBe(true);
  expect(target.endsWith(suffix), `unexpected package target: ${target}`).toBe(true);
  return target.replace("./dist/", "./src/").slice(0, -suffix.length) + ".ts";
}

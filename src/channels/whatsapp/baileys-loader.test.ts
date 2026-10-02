import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BUNDLED_BAILEYS_RELATIVE_PATH,
  bareBaileysSpecifier,
  baileys,
  bundledBaileysPath,
  isBaileysLoaded,
  loadBaileys,
  resetBaileysLoaderForTests,
} from "./baileys-loader.js";

const realBaileys = await loadBaileys();
const fakeModule = { ...realBaileys };

afterEach(async () => {
  // Every other test in this process expects the real module to stay loaded.
  resetBaileysLoaderForTests();
  await loadBaileys();
});

describe("baileys loader", () => {
  it("resolves the vendored bundle next to the running bundle file", () => {
    expect(BUNDLED_BAILEYS_RELATIVE_PATH).toBe("../vendor/baileys.js");
    expect(bundledBaileysPath("file:///opt/ravi/dist/bundle/index.js")).toBe("/opt/ravi/dist/vendor/baileys.js");
  });

  it("builds the bare specifier at run time (never a literal the bundler could inline)", () => {
    expect(bareBaileysSpecifier()).toBe("baileys");
  });

  it("imports the vendored bundle by absolute file URL when it exists", async () => {
    resetBaileysLoaderForTests();
    const importModule = mock(async (_specifier: string) => fakeModule);
    const loaded = await loadBaileys({
      bundledPath: "/opt/ravi/dist/vendor/baileys.js",
      exists: (path) => path === "/opt/ravi/dist/vendor/baileys.js",
      importModule,
    });
    expect(loaded).toBe(fakeModule);
    expect(importModule.mock.calls).toEqual([[pathToFileURL("/opt/ravi/dist/vendor/baileys.js").href]]);
    expect(baileys()).toBe(fakeModule);
  });

  it("falls back to the bare package when no vendored bundle exists", async () => {
    resetBaileysLoaderForTests();
    const importModule = mock(async (_specifier: string) => fakeModule);
    await loadBaileys({ bundledPath: "/nope/vendor/baileys.js", exists: () => false, importModule });
    expect(importModule.mock.calls).toEqual([["baileys"]]);
  });

  it("baileys() throws until a load completed", async () => {
    resetBaileysLoaderForTests();
    expect(isBaileysLoaded()).toBe(false);
    expect(() => baileys()).toThrow("await loadBaileys()");
    await loadBaileys();
    expect(isBaileysLoaded()).toBe(true);
    expect(baileys().makeWASocket).toBe(realBaileys.makeWASocket);
  });

  it("shares one in-flight load between concurrent callers", async () => {
    resetBaileysLoaderForTests();
    const importModule = mock(async (_specifier: string) => fakeModule);
    const options = { exists: () => false, importModule };
    const [first, second] = await Promise.all([loadBaileys(options), loadBaileys(options)]);
    expect(first).toBe(second);
    expect(importModule).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed load: the next call tries again", async () => {
    resetBaileysLoaderForTests();
    let calls = 0;
    const importModule = mock(async (_specifier: string) => {
      calls++;
      if (calls === 1) throw new Error("Cannot find module 'dist/vendor/baileys.js'");
      return fakeModule;
    });
    const options = { exists: () => false, importModule };
    await expect(loadBaileys(options)).rejects.toThrow("Cannot find module");
    expect(isBaileysLoaded()).toBe(false);
    await expect(loadBaileys(options)).resolves.toBe(fakeModule);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("rejects a module that is not Baileys", async () => {
    resetBaileysLoaderForTests();
    await expect(
      loadBaileys({ exists: () => true, bundledPath: "/x/vendor/baileys.js", importModule: async () => ({}) }),
    ).rejects.toThrow("/x/vendor/baileys.js is not a Baileys module");
    expect(isBaileysLoaded()).toBe(false);
  });
});

describe("no value import of baileys in ravi source", () => {
  it("every static import/export from baileys is type-only, and nothing awaits import('baileys')", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => /\.tsx?$/.test(file));
    const offenders: string[] = [];
    const staticImport = /^\s*(?:import|export)\s+([^;]*?)\s+from\s+["']baileys["']/gm;
    for (const relative of files) {
      const text = readFileSync(join(root, relative), "utf8");
      if (!text.includes("baileys")) continue;
      for (const match of text.matchAll(staticImport)) {
        const clause = (match[1] ?? "").trim();
        const typeOnly =
          clause.startsWith("type ") ||
          (/^\{[\s\S]*\}$/.test(clause) &&
            clause
              .slice(1, -1)
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
              .every((part) => part.startsWith("type ")));
        if (!typeOnly) offenders.push(`src/${relative}: ${clause}`);
      }
      if (/\bawait\s+import\(\s*["']baileys["']\s*\)|\brequire\(\s*["']baileys["']\s*\)/.test(text)) {
        offenders.push(`src/${relative}: dynamic import of "baileys"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

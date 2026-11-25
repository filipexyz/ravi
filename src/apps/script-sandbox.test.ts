import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppScriptError, runAppScript } from "./script-sandbox.js";
import { checkThenArgs, collectScriptInput, readScriptSource, stageScriptOutput } from "./script-operation.js";
import { classifyAppManifest } from "./store/classify.js";
import type { RaviAppManifest } from "./types.js";

async function scriptError(source: string, overrides = {}): Promise<AppScriptError> {
  try {
    await runAppScript(source, { args: [], files: {} }, overrides);
  } catch (error) {
    if (error instanceof AppScriptError) return error;
    throw error;
  }
  throw new Error("expected the script to fail");
}

describe("script sandbox", () => {
  it("runs main and returns files, args and result", async () => {
    const output = await runAppScript(
      `function main(input) { return { files: { "index.html": "<h1>" + input.files["a.md"] + "</h1>" }, args: ["--title", input.args[0]], result: { n: 1 } }; }`,
      { args: ["Hi"], files: { "a.md": "x" } },
    );
    expect(output.files).toEqual({ "index.html": "<h1>x</h1>" });
    expect(output.args).toEqual(["--title", "Hi"]);
    expect(output.result).toEqual({ n: 1 });
  });

  it("exposes no host capability", async () => {
    const output = await runAppScript(
      `function main() { return { result: [typeof require, typeof process, typeof fetch, typeof std, typeof os, typeof Bun, typeof setTimeout, typeof XMLHttpRequest, typeof WebAssembly] }; }`,
      { args: [], files: {} },
    );
    expect(output.result).toEqual(Array(9).fill("undefined"));
  });

  it("cannot load modules", async () => {
    const output = await runAppScript(
      `var r = "none"; import("std").then(() => { r = "loaded"; }, () => { r = "refused"; }); function main() { return { result: r }; }`,
      { args: [], files: {} },
    );
    expect(output.result).not.toBe("loaded");
    const error = await scriptError(`import * as os from "os"; function main() { return {}; }`);
    expect(error.code).toBe("APP_SCRIPT_FAILED");
  });

  it("stops a script that runs too long", async () => {
    const error = await scriptError(`function main() { while (true) {} }`, { timeoutMs: 200 });
    expect(error.code).toBe("APP_SCRIPT_LIMIT");
  });

  it("stops a script that allocates too much", async () => {
    const error = await scriptError(
      `function main() { var a = []; for (;;) a.push(new Array(100000).fill("xxxxxxxxxx")); }`,
      { memoryBytes: 8 * 1024 * 1024 },
    );
    expect(error.code).toBe("APP_SCRIPT_LIMIT");
  });

  it("stops unbounded recursion", async () => {
    const error = await scriptError(`function f() { return f() + 1; } function main() { return { result: f() }; }`);
    expect(["APP_SCRIPT_LIMIT", "APP_SCRIPT_FAILED"]).toContain(error.code);
  });

  it("refuses unsafe output paths and non-text files", async () => {
    for (const path of ["../x", "/etc/passwd", ".hidden", "a//b", "a\\\\b"]) {
      const error = await scriptError(`function main() { return { files: { ${JSON.stringify(path)}: "x" } }; }`);
      expect(error.code).toBe("APP_SCRIPT_OUTPUT_INVALID");
    }
    expect((await scriptError(`function main() { return { files: { "a.txt": 1 } }; }`)).code).toBe(
      "APP_SCRIPT_OUTPUT_INVALID",
    );
  });

  it("refuses async main, a missing main and oversized output", async () => {
    expect((await scriptError(`async function main() { return {}; }`)).code).toBe("APP_SCRIPT_FAILED");
    expect((await scriptError(`var x = 1;`)).code).toBe("APP_SCRIPT_FAILED");
    expect(
      (await scriptError(`function main() { return { result: "x".repeat(5000) }; }`, { outputBytes: 1000 })).code,
    ).toBe("APP_SCRIPT_LIMIT");
  });
});

describe("script operation host", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ravi-script-op-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the declared folder inside the working directory", () => {
    mkdirSync(join(root, "cwd", "posts", "sub"), { recursive: true });
    writeFileSync(join(root, "cwd", "posts", "a.md"), "A");
    writeFileSync(join(root, "cwd", "posts", "sub", "b.md"), "B");
    writeFileSync(join(root, "cwd", "posts", ".env"), "SECRET=1");
    const input = collectScriptInput(["--title", "T", "--posts", "posts"], "--posts", join(root, "cwd"));
    expect(input.args).toEqual(["--title", "T"]);
    expect(input.files).toEqual({ "a.md": "A", "sub/b.md": "B" });
  });

  it("refuses folders outside the working directory and symbolic links", () => {
    mkdirSync(join(root, "cwd", "posts"), { recursive: true });
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "secret.md"), "S");
    const cwd = join(root, "cwd");
    expect(() => collectScriptInput(["--posts", "../outside"], "--posts", cwd)).toThrow(AppScriptError);
    expect(() => collectScriptInput(["--posts", join(root, "outside")], "--posts", cwd)).toThrow(AppScriptError);
    symlinkSync(join(root, "outside"), join(cwd, "link"));
    expect(() => collectScriptInput(["--posts", "link"], "--posts", cwd)).toThrow(AppScriptError);
    symlinkSync(join(root, "outside", "secret.md"), join(cwd, "posts", "secret.md"));
    expect(() => collectScriptInput(["--posts", "posts"], "--posts", cwd)).toThrow(AppScriptError);
    expect(() => collectScriptInput(["--posts", "posts", "--posts=posts"], "--posts", cwd)).toThrow(AppScriptError);
  });

  it("lets the script pass only declared flags with plain values", () => {
    expect(checkThenArgs(["--route", "/blog", "--title", "T"], ["--route", "--title"])).toEqual([
      "--route",
      "/blog",
      "--title",
      "T",
    ]);
    expect(() => checkThenArgs(["--dir", "/etc"], ["--route"])).toThrow(AppScriptError);
    expect(() => checkThenArgs(["--route", "--dir"], ["--route"])).toThrow(AppScriptError);
    expect(() => checkThenArgs(["--route"], ["--route"])).toThrow(AppScriptError);
    expect(() => checkThenArgs(["--route=/x"], ["--route"])).toThrow(AppScriptError);
  });

  it("reads the script only from inside the app folder", () => {
    mkdirSync(join(root, "app", "lib"), { recursive: true });
    writeFileSync(join(root, "app", "lib", "a.js"), "function main(){return {}}");
    writeFileSync(join(root, "outside.js"), "x");
    expect(readScriptSource(join(root, "app"), "lib/a.js")).toContain("main");
    expect(() => readScriptSource(join(root, "app"), "../outside.js")).toThrow(AppScriptError);
    symlinkSync(join(root, "outside.js"), join(root, "app", "lib", "b.js"));
    expect(() => readScriptSource(join(root, "app"), "lib/b.js")).toThrow(AppScriptError);
  });

  it("stages output files in a private folder", () => {
    const dir = stageScriptOutput({ "index.html": "x", "a/b.html": "y" });
    try {
      expect(readFileSync(join(dir, "a", "b.html"), "utf8")).toBe("y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("script classification", () => {
  const registry = {
    groups: [{ name: "pages", aliases: [] }],
    commands: [
      {
        groupPath: "pages",
        groupSegments: ["pages"],
        command: "ship",
        aliases: [],
        cliOnly: false,
        access: { kind: "mutate" },
      },
    ],
  } as never;

  function manifest(then: Record<string, unknown>): RaviAppManifest {
    return {
      schema: "ravi.app/v1",
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      description: "d",
      interfaces: { cli: { command: "ravi pages", json: true } },
      operations: {
        "demo.publish": {
          interface: "script",
          script: "lib/a.js",
          handoff: then,
          mutating: true,
          permission: "demo:write",
        },
      },
      permissions: { required: [], optional: ["demo:write"], mutating: ["demo:write"] },
    } as unknown as RaviAppManifest;
  }

  it("accepts a sandboxed script whose handoff step is an exposed ravi command", () => {
    const result = classifyAppManifest(
      manifest({ command: "ravi pages ship --json {args}", outputFlag: "--dir", flags: ["--route"] }),
      { registry },
    );
    expect(result.reasons).toEqual([]);
    expect(result.class).toBe("compose");
    expect(result.grants.operations["demo.publish"]?.runs).toContain("sandbox:lib/a.js then ravi pages ship");
  });

  it("refuses a then step that is not ravi or that the script could override", () => {
    expect(classifyAppManifest(manifest({ command: "sh -c {args}", outputFlag: "--dir" }), { registry }).class).toBe(
      "code",
    );
    expect(
      classifyAppManifest(
        manifest({ command: "ravi pages ship --route /x {args}", outputFlag: "--dir", flags: ["--route"] }),
        { registry },
      ).class,
    ).toBe("code");
  });
});

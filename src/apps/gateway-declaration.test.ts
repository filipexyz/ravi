import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGatewayArgs, normalizeGatewayDeclaration, validateGatewayDeclaration } from "./gateway-declaration.js";
import { getAppManifest } from "./service.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.RAVI_STATE_DIR;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRepoWithGateway(gateway: unknown, command = "bun slides.mjs list {args} --json"): void {
  const root = mkdtempSync(join(tmpdir(), "ravi-app-gateway-decl-"));
  tempRoots.push(root);
  process.env.RAVI_STATE_DIR = join(root, ".state");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  const dir = join(root, "src", "apps", "slides");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "ravi.app.json"),
    JSON.stringify({
      schema: "ravi.app/v1",
      id: "slides",
      name: "Slides",
      version: "0.1.0",
      description: "Slides.",
      interfaces: { cli: { command: "bun slides.mjs", json: true } },
      context: { allow: [] },
      operations: {
        "slides.list": {
          interface: "cli",
          command,
          mutating: false,
          gateway,
        },
      },
      permissions: { required: [], optional: [], mutating: [] },
    }),
  );
  process.chdir(root);
}

const LIST_DECLARATION = { args: { options: ["--limit", "--cursor"], flags: ["--archived"], positional: 1 } };

describe("app gateway declaration", () => {
  it("accepts a valid declaration in ravi apps check", () => {
    makeRepoWithGateway(LIST_DECLARATION);
    const app = getAppManifest("slides");
    expect(app.errors).toEqual([]);
    expect(app.valid).toBe(true);
  });

  it("refuses invalid declarations in ravi apps check", () => {
    makeRepoWithGateway({ args: { options: ["--execute", "-l", "--limit"], flags: ["--limit"], positional: 9 } });
    const app = getAppManifest("slides");
    const errors = app.errors.join("\n");
    expect(app.valid).toBe(false);
    expect(errors).toContain("operations.slides.list.gateway.args.options must never declare --execute.");
    expect(errors).toContain('entry "-l" must match');
    expect(errors).toContain("must be disjoint");
    expect(errors).toContain("positional must be an integer from 0 to 8");
  });

  it("refuses commands that let the viewer choose what runs in ravi apps check", () => {
    makeRepoWithGateway(LIST_DECLARATION, "ravi {args}");
    let app = getAppManifest("slides");
    expect(app.valid).toBe(false);
    expect(app.errors.join("\n")).toContain(
      "operations.slides.list.command cannot be exposed through the Pages app gateway: the words before {args} must start with one full Ravi CLI command",
    );

    makeRepoWithGateway(LIST_DECLARATION, "bun slides.mjs {args} list");
    app = getAppManifest("slides");
    expect(app.valid).toBe(false);
    expect(app.errors.join("\n")).toContain('"list" comes after {args}');

    makeRepoWithGateway({ args: "none" }, "ravi {args}");
    expect(getAppManifest("slides").errors).toEqual([]);
  });

  it("validates shape, limits, and the none form", () => {
    const errors: string[] = [];
    validateGatewayDeclaration({ args: "none" }, "gateway", errors);
    expect(errors).toEqual([]);
    validateGatewayDeclaration({ args: "all" }, "gateway", errors);
    validateGatewayDeclaration({ args: {}, extra: true }, "gateway", errors);
    validateGatewayDeclaration({ args: { flags: ["--"] } }, "gateway", errors);
    validateGatewayDeclaration(
      { args: { options: Array.from({ length: 17 }, (_, index) => `--o${index}`) } },
      "gateway",
      errors,
    );
    validateGatewayDeclaration({ args: { options: ["--a", "--a"] } }, "gateway", errors);
    const text = errors.join("\n");
    expect(text).toContain('gateway.args must be "none"');
    expect(text).toContain('gateway only accepts "args"');
    expect(text).toContain("gateway.args.flags must never declare --.");
    expect(text).toContain("lists at most 16 names");
    expect(text).toContain("lists --a more than once");
    expect(normalizeGatewayDeclaration(undefined)).toBeNull();
    expect(normalizeGatewayDeclaration({ args: { options: ["--execute"] } })).toBeNull();
  });

  it("accepts declared args unchanged and in order", () => {
    const declaration = normalizeGatewayDeclaration(LIST_DECLARATION)!;
    expect(checkGatewayArgs(declaration, [])).toEqual({ ok: true });
    expect(checkGatewayArgs(declaration, ["--limit", "10", "--archived", "deck-1", "--cursor", "abc"])).toEqual({
      ok: true,
    });
  });

  it("refuses every argv injection shape before anything runs", () => {
    const declaration = normalizeGatewayDeclaration(LIST_DECLARATION)!;
    const refused: string[][] = [
      ["--format", "x"], // undeclared option
      ["--limit=10"], // --name=value form
      ["-l", "10"], // short option
      ["--"], // end of options
      ["--execute"], // write brake
      ["--limit", "-1"], // option value starting with -
      ["--limit"], // option without value
      ["--limit", "1", "--limit", "2"], // repeated option
      ["--archived", "--archived"], // repeated flag
      ["a", "b"], // one positional more than declared
    ];
    for (const args of refused) {
      expect(checkGatewayArgs(declaration, args).ok).toBe(false);
    }

    const none = normalizeGatewayDeclaration({ args: "none" })!;
    expect(checkGatewayArgs(none, []).ok).toBe(true);
    expect(checkGatewayArgs(none, ["anything"]).ok).toBe(false);
  });
});

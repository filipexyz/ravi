import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppsCommands } from "./apps.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-apps-cli-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "apps", "apps"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  writeFileSync(
    join(root, "src", "apps", "apps", "ravi.app.json"),
    JSON.stringify(
      {
        schema: "ravi.app/v1",
        id: "apps",
        name: "Ravi Apps",
        version: "0.1.0",
        description: "Discover and validate app manifests.",
        interfaces: {
          cli: {
            command: "ravi apps",
            json: true,
          },
          sdk: {
            namespace: "apps",
          },
        },
        permissions: {
          required: [],
          optional: [],
          mutating: [],
        },
        health: {
          checks: [],
        },
      },
      null,
      2,
    ),
  );
  process.chdir(root);
  return root;
}

function captureJson(fn: () => unknown): unknown {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    fn();
    return JSON.parse(logs.join("\n"));
  } finally {
    console.log = originalLog;
  }
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe("AppsCommands", () => {
  it("lists, shows, and checks app manifests as JSON", () => {
    makeRepo();
    const commands = new AppsCommands();

    const list = captureJson(() => commands.list(undefined, true)) as {
      total: number;
      apps: Array<{ id: string; valid: boolean; interfaceNames: string[] }>;
    };
    expect(list.total).toBe(1);
    expect(list.apps[0]).toMatchObject({ id: "apps", valid: true, interfaceNames: ["cli", "sdk"] });

    const show = captureJson(() => commands.show("apps", true)) as {
      app: { id: string; manifest: { schema: string } };
    };
    expect(show.app.id).toBe("apps");
    expect(show.app.manifest.schema).toBe("ravi.app/v1");

    const check = captureJson(() => commands.check("apps", true)) as {
      ok: boolean;
      checked: number;
      results: Array<{ id: string; ok: boolean }>;
    };
    expect(check).toMatchObject({ ok: true, checked: 1 });
    expect(check.results[0]).toMatchObject({ id: "apps", ok: true });
  });
});

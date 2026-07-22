import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAppOperation } from "../router.js";
import { publicTinyQuota, TINY_V2_QUOTA } from "./quota.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.RAVI_STATE_DIR;

afterEach(() => {
  process.chdir(originalCwd);
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("Tiny public router envelope", () => {
  test("wraps paginated, empty, invalid, and failed Tiny results in versioned contracts", async () => {
    const root = createTinyFixture();

    const page1 = await runTinyOperation(root, "page1");
    const page2 = await runTinyOperation(root, "page2");
    const empty = await runTinyOperation(root, "empty");
    for (const [operation, result] of [
      ["page1", page1],
      ["page2", page2],
      ["empty", empty],
    ] as const) {
      expect(result).toMatchObject({
        schema: "ravi.app.operation-result/v1",
        ok: true,
        appId: "tiny",
        operation,
        result: { ok: true, dryRun: false, tenant: "acme" },
      });
    }
    expect(page1.result).toMatchObject({ data: { retorno: { pagina: 1, numero_paginas: 2 } } });
    expect(page2.result).toMatchObject({ data: { retorno: { pagina: 2, numero_paginas: 2 } } });
    expect(empty.result).toMatchObject({ data: { retorno: { pagina: 1, numero_paginas: 0, contatos: [] } } });

    const invalid = await runTinyOperation(root, "invalid");
    expect(invalid).toMatchObject({
      schema: "ravi.app.operation-result/v1",
      ok: false,
      failure: {
        version: "ravi.app.failure/v1",
        code: "APP_OUTPUT_SCHEMA_MISMATCH",
        category: "protocol",
        exitCode: 7,
      },
    });
    expect(invalid.stdout).toBeUndefined();

    const failed = await runTinyOperation(root, "error");
    expect(failed).toMatchObject({
      schema: "ravi.app.operation-result/v1",
      ok: false,
      failure: {
        version: "ravi.app.failure/v1",
        code: "TINY_HTTP_RATE_LIMITED",
        category: "rate_limit",
        retryable: true,
        exitCode: 5,
        details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 2 },
      },
    });
    expect(failed.stdout).toBeUndefined();
    expect(failed.stderr).toBeUndefined();
  });
});

function createTinyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-tiny-envelope-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "tiny-envelope-fixture" }));

  const appRoot = join(root, "src", "apps", "tiny");
  mkdirSync(join(appRoot, "schemas"), { recursive: true });
  writeFileSync(
    join(appRoot, "schemas", "read-output.schema.json"),
    readFileSync(join(import.meta.dir, "schemas", "read-output.schema.json"), "utf8"),
  );

  const quota = { policy: publicTinyQuota(TINY_V2_QUOTA), observed: { limitPerMinute: null, retryAfterSeconds: null } };
  const outputs = {
    page1: tinyReadResult(
      {
        status: "OK",
        status_processamento: "3",
        pagina: 1,
        numero_paginas: 2,
        produtos: [{ produto: { id: "1" } }],
      },
      quota,
    ),
    page2: tinyReadResult(
      {
        status: "OK",
        status_processamento: "3",
        pagina: 2,
        numero_paginas: 2,
        produtos: [{ produto: { id: "2" } }],
      },
      quota,
    ),
    empty: tinyReadResult(
      { status: "OK", status_processamento: "3", pagina: 1, numero_paginas: 0, contatos: [] },
      quota,
    ),
    invalid: { ok: true, dryRun: false, tenant: "acme", data: { retorno: { status: "OK" } } },
  };
  writeFileSync(
    join(appRoot, "cli.mjs"),
    `const mode = process.argv[2];
const outputs = ${JSON.stringify(outputs)};
if (mode === "error") {
  process.stdout.write(JSON.stringify({ ok: false, failure: {
    version: "ravi.app.failure/v1", code: "TINY_HTTP_RATE_LIMITED", category: "rate_limit",
    message: "Tiny rate limit was reached; no automatic retry was attempted.", retryable: true, exitCode: 5,
    details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 2, secret: "discard-me" }
  } }));
  process.exit(5);
}
process.stdout.write(JSON.stringify(outputs[mode]));
`,
  );

  const operations = Object.fromEntries(
    ["page1", "page2", "empty", "invalid", "error"].map((name) => [
      `tiny.${name}`,
      {
        interface: "cli",
        command: `node ./cli.mjs ${name} --json`,
        json: true,
        mutating: false,
        safety: {
          idempotent: true,
          dryRunSupported: true,
          confirmationRequired: false,
          liveExecution: true,
        },
        reliability: { timeoutMs: 1000, maxAttempts: 1 },
        outputSchema: "schemas/read-output.schema.json",
      },
    ]),
  );
  writeFileSync(
    join(appRoot, "ravi.app.json"),
    JSON.stringify({
      schema: "ravi.app/v1",
      id: "tiny",
      name: "Tiny fixture",
      version: "1.0.0",
      description: "Tiny router contract fixture.",
      interfaces: { cli: { command: "ravi tiny", json: true } },
      operations,
      permissions: { required: [], optional: [], mutating: [] },
      health: {
        checks: [
          { id: "manifest", type: "builtin", required: true, sideEffectFree: true, handler: "apps.manifest.check" },
        ],
      },
    }),
  );
  return root;
}

function runTinyOperation(root: string, operation: string) {
  return runAppOperation({
    appId: "tiny",
    operation,
    json: true,
    cwd: root,
    env: { ...process.env, RAVI_STATE_DIR: join(root, ".state") },
  });
}

function tinyReadResult(retorno: Record<string, unknown>, quota: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, dryRun: false, tenant: "acme", data: { retorno }, quota };
}

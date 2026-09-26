/**
 * `artifacts create` through the real SDK gateway: isolated CLIs dispatch to
 * the daemon, so a relative `--path` must resolve against the caller cwd, and
 * expected input failures must return a typed USAGE_ERROR instead of an opaque
 * UNHANDLED_ERROR / HTTP 500.
 */

import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactsCommands } from "../../cli/commands/artifacts.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { CALLER_CWD_HEADER, dispatchRemote, remoteGatewayErrorToContractError } from "../../cli/remote-gateway.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { ContextRecord } from "../../router/router-db.js";
import { startGateway, type GatewayHandle } from "./server.js";

const registry = buildRegistry([ArtifactsCommands]);
const allowedContext: ContextRecord = {
  contextId: "ctx_artifacts_create_gateway_test",
  contextKey: "rctx_artifacts_create_gateway_test",
  kind: "test-runtime",
  agentId: "gateway-artifacts-agent",
  sessionKey: "agent:gateway-artifacts-agent:main",
  sessionName: "gateway-artifacts-main",
  capabilities: [{ permission: "execute", objectType: "group", objectId: "artifacts", source: "test" }],
  metadata: { authorityMode: "delegated" },
  createdAt: Date.now(),
};

let stateDir: string | null = null;
let handle: GatewayHandle | null = null;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface GatewayReply {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function post(command: string, body: Record<string, unknown>, cwd?: string): Promise<GatewayReply> {
  const res = await fetch(`${handle!.url}/api/v1/artifacts/${command}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${allowedContext.contextKey}`,
      "content-type": "application/json",
      ...(cwd ? { [CALLER_CWD_HEADER]: cwd } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
}

async function artifactTotal(): Promise<number> {
  const listed = await post("list", {});
  expect(listed.status).toBe(200);
  return listed.body.total as number;
}

function expectUsageError(reply: GatewayReply, message: string | RegExp): Record<string, any> {
  expect(reply.status).toBe(400);
  expect(reply.body).toMatchObject({
    success: false,
    op: "artifacts create",
    exitCode: 2,
    outcome: "usage_error",
    error: { code: "USAGE_ERROR", retryable: false },
  });
  expect(reply.body.error.code).not.toBe("UNHANDLED_ERROR");
  if (typeof message === "string") expect(reply.body.error.message).toBe(message);
  else expect(reply.body.error.message).toMatch(message);
  return reply.body.error;
}

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sdk-gateway-artifacts-create-");
  handle = startGateway({
    host: "127.0.0.1",
    port: 0,
    registry,
    auth: {
      resolveContext(token) {
        return token === allowedContext.contextKey ? { ...allowedContext } : null;
      },
    },
  });
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("gateway — artifacts.create with local files", () => {
  it("resolves a relative --path against the caller cwd, never the daemon cwd", async () => {
    const callerDir = tempDir("ravi-artifacts-caller-");
    const daemonDir = tempDir("ravi-artifacts-daemon-");
    mkdirSync(join(callerDir, "out"));
    mkdirSync(join(daemonDir, "out"));
    writeFileSync(join(callerDir, "out", "evidence.md"), "caller evidence\n");
    writeFileSync(join(daemonDir, "out", "evidence.md"), "daemon decoy\n");

    const originalCwd = process.cwd();
    process.chdir(daemonDir);
    let reply: GatewayReply;
    try {
      reply = await post("create", { path: "./out/evidence.md", title: "Caller evidence" }, callerDir);
    } finally {
      process.chdir(originalCwd);
    }

    expect(reply.status).toBe(200);
    const artifact = reply.body.artifact;
    expect(artifact.filePath).toBe(join(callerDir, "out", "evidence.md"));
    expect(artifact.sha256).toBe(sha256("caller evidence\n"));
    expect(readFileSync(artifact.blobPath, "utf8")).toBe("caller evidence\n");
    expect(artifact).toMatchObject({
      agentId: allowedContext.agentId,
      sessionKey: allowedContext.sessionKey,
      mimeType: "text/plain",
    });
  });

  it("creates and links outputs to a Task and a Project in a serialized runner loop", async () => {
    const callerDir = tempDir("ravi-artifacts-runner-");
    const createdIds: string[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const fileName = `evidence-${attempt}.md`;
      writeFileSync(join(callerDir, fileName), `# Evidence ${attempt}\n`);

      const created = await post(
        "create",
        { path: `./${fileName}`, title: `Custody evidence ${attempt}`, task: "task-custody-1", tags: "e2e,custody" },
        callerDir,
      );
      expect(created.status).toBe(200);
      expect(created.body.success).toBe(true);
      const id = created.body.artifact.id as string;
      expect(created.body.artifact.taskId).toBe("task-custody-1");
      createdIds.push(id);

      const linkedTask = await post("attach", {
        id,
        targetType: "task",
        targetId: "task-custody-1",
        relation: "output",
      });
      expect(linkedTask.status).toBe(200);
      const linkedProject = await post("attach", {
        id,
        targetType: "project",
        targetId: "proj-custody-1",
        relation: "evidence",
      });
      expect(linkedProject.status).toBe(200);

      const shown = await post("show", { id });
      expect(shown.status).toBe(200);
      expect(shown.body.links).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ targetType: "task", targetId: "task-custody-1", relation: "output" }),
          expect.objectContaining({ targetType: "project", targetId: "proj-custody-1", relation: "evidence" }),
        ]),
      );
      expect(shown.body.versions).toHaveLength(1);
      expect(shown.body.artifact.tags).toEqual(["custody", "e2e"]);
    }

    expect(new Set(createdIds).size).toBe(3);
    const byTask = await post("list", { task: "task-custody-1" });
    expect(byTask.status).toBe(200);
    expect(byTask.body.total).toBe(3);
  });

  it("ingests a relative directory as a versioned package", async () => {
    const callerDir = tempDir("ravi-artifacts-package-");
    mkdirSync(join(callerDir, "site", "assets"), { recursive: true });
    writeFileSync(join(callerDir, "site", "index.html"), "<h1>Report</h1>");
    writeFileSync(join(callerDir, "site", "assets", "app.js"), "console.log('ok');");

    const reply = await post("create", { path: "./site", title: "Report site" }, callerDir);

    expect(reply.status).toBe(200);
    expect(reply.body.package).toMatchObject({ entrypoint: "index.html", fileCount: 2, isDirectory: true });
    expect(reply.body.version).toMatchObject({ versionNumber: 1, assetCount: 2 });
  });

  it("updates content from a relative --path and records a new version", async () => {
    const callerDir = tempDir("ravi-artifacts-update-");
    writeFileSync(join(callerDir, "v1.md"), "v1\n");
    writeFileSync(join(callerDir, "v2.md"), "v2\n");
    mkdirSync(join(callerDir, "folder"));

    const created = await post("create", { path: "./v1.md", title: "Versioned" }, callerDir);
    expect(created.status).toBe(200);
    const id = created.body.artifact.id as string;

    const updated = await post("update", { id, path: "./v2.md" }, callerDir);
    expect(updated.status).toBe(200);
    expect(updated.body.artifact.sha256).toBe(sha256("v2\n"));

    const versions = await post("versions", { id });
    expect(versions.body.total).toBe(2);

    const directory = await post("update", { id, path: "./folder" }, callerDir);
    expect(directory.status).toBe(400);
    expect(directory.body).toMatchObject({
      op: "artifacts update",
      exitCode: 2,
      error: { code: "USAGE_ERROR", message: "--path must be a file: ./folder" },
    });
  });
});

describe("gateway — artifacts.create expected failures are typed", () => {
  it("returns USAGE_ERROR with the reason for a missing --path, without leaking absolute paths", async () => {
    const callerDir = tempDir("ravi-artifacts-missing-");

    const relative = await post("create", { path: "./out/missing.md" }, callerDir);
    const error = expectUsageError(relative, "--path was not found: ./out/missing.md");
    expect(error.issues).toEqual([
      { path: ["path"], code: "not_found", message: "--path was not found: ./out/missing.md" },
    ]);
    expect(error.suggestedAction).toContain("relative paths resolve against the caller working directory");
    expect(relative.text).not.toContain(callerDir);

    const absolute = await post("create", { path: join(callerDir, "missing.md") }, callerDir);
    expectUsageError(absolute, "--path was not found: missing.md");
    expect(absolute.text).not.toContain(callerDir);

    expect(await artifactTotal()).toBe(0);
  });

  it("maps store schema violations to USAGE_ERROR with field issues", async () => {
    const callerDir = tempDir("ravi-artifacts-schema-");
    writeFileSync(join(callerDir, "report.md"), "# ok\n");

    const badKind = await post("create", { path: "./report.md", kind: "Bad Kind" }, callerDir);
    const kindError = expectUsageError(badKind, /^Invalid --kind: /);
    expect(kindError.issues).toEqual([expect.objectContaining({ path: ["kind"] })]);

    const longTitle = await post("create", { title: "x".repeat(201) });
    const titleError = expectUsageError(longTitle, /^Invalid --title: /);
    expect(titleError.issues).toEqual([expect.objectContaining({ path: ["title"] })]);

    expect(await artifactTotal()).toBe(0);
  });

  it("maps package validation failures to USAGE_ERROR", async () => {
    const callerDir = tempDir("ravi-artifacts-bad-package-");
    mkdirSync(join(callerDir, "hidden"));
    writeFileSync(join(callerDir, "hidden", "index.html"), "<h1>Hi</h1>");
    writeFileSync(join(callerDir, "hidden", ".env"), "SECRET=1");
    mkdirSync(join(callerDir, "no-index"));
    writeFileSync(join(callerDir, "no-index", "page.html"), "<h1>Hi</h1>");

    const hidden = await post("create", { path: "./hidden" }, callerDir);
    expectUsageError(hidden, "Invalid artifact package asset path: .env");

    const noIndex = await post("create", { path: "./no-index" }, callerDir);
    const noIndexError = expectUsageError(noIndex, "Artifact package entrypoint is not included in files: index.html");
    expect(noIndexError.issues).toEqual([expect.objectContaining({ path: ["entrypoint"] })]);

    expect(await artifactTotal()).toBe(0);
  });
});

describe("remote CLI transport — artifacts create", () => {
  it("sends the caller cwd and renders typed failures with their reason", async () => {
    const callerDir = tempDir("ravi-artifacts-remote-");
    writeFileSync(join(callerDir, "evidence.md"), "remote evidence\n");
    const config = { url: handle!.url, source: "env" as const };

    const ok = await dispatchRemote({
      groupSegments: ["artifacts"],
      command: "create",
      body: { path: "./evidence.md", title: "Remote evidence" },
      config,
      contextKey: allowedContext.contextKey,
      cwd: callerDir,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({
      success: true,
      artifact: { filePath: join(callerDir, "evidence.md"), sha256: sha256("remote evidence\n") },
    });

    const missing = await dispatchRemote({
      groupSegments: ["artifacts"],
      command: "create",
      body: { path: "./missing.md" },
      config,
      contextKey: allowedContext.contextKey,
      cwd: callerDir,
    });
    expect(missing.status).toBe(400);
    const rendered = remoteGatewayErrorToContractError("artifacts create", missing);
    expect(rendered).toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: "path: --path was not found: ./missing.md",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { serve } from "bun";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import type { ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { AuthorizeMcpUseDeps } from "./authorize.js";
import { McpCallFollower } from "./call-follower.js";
import { getMcpCall } from "./calls-db.js";
import { buildMcpCatalog, listAuthorizedMcpTools } from "./catalog.js";
import { mcpCatalogForAttachment } from "./extensions.js";
import {
  MCP_FILE_HANDLE_DESCRIPTION,
  type McpFileGateDeps,
  rewriteMcpFileSchema,
  stageMcpFileArguments,
} from "./files.js";
import { McpGateway, type McpGatewayCallResult, type McpGatewayOptions } from "./gateway.js";
import {
  attachMcpServer,
  createMcpServer,
  getMcpServer,
  getMcpAttachment,
  recordMcpServerProbe,
  setMcpConfigChangedEmitterForTests,
  updateMcpAttachments,
} from "./registry-db.js";
import { writeMcpServerSecret } from "./secrets.js";
import { type FilesFixture, startFilesFixture } from "./test-fixtures/files-server.js";
import { type McpCallTraceInput, setMcpTraceSinksForTests } from "./trace.js";
import {
  httpsMcpUploadTransport,
  isPublicMcpUploadAddress,
  type McpUploadLookup,
  type McpUploadRequest,
  performMcpUploads,
  setMcpUploadTestCaForTests,
  validateMcpUploadTargets,
} from "./upload-target.js";

const AGENT = "main";
const SESSION = "main-session";
const PUBLIC_ADDRESS = "93.184.216.34";

let stateDir: string;
let workspace: string;
let outside: string;
let fixture: FilesFixture | null = null;
let gateways: McpGateway[] = [];
let followers: McpCallFollower[] = [];
let traces: McpCallTraceInput[] = [];
let uploads: McpUploadRequest[] = [];
let uploadStatus = 200;
let agentRow: { cwd: string | null; remote: string | null } | null = null;
let gate: McpFileGateDeps;
let clock = 0;

const authorize: AuthorizeMcpUseDeps = { isOperatorOwnTurn: () => true, canUseTool: () => true };

const publicLookup: McpUploadLookup = async () => [{ address: PUBLIC_ADDRESS, family: 4 }];

function context(): ContextRecord {
  return {
    contextId: "ctx_files",
    contextKey: "rctx_files",
    kind: "agent-runtime",
    agentId: AGENT,
    sessionKey: "agent:main:main",
    sessionName: SESSION,
    capabilities: [],
    metadata: {},
    createdAt: Date.now(),
  };
}

beforeEach(async () => {
  stateDir = (await createIsolatedRaviState("ravi-mcp-files-")) as string;
  setMcpConfigChangedEmitterForTests(() => {});
  setPermissionAuditPublisherForTest(() => {});
  traces = [];
  setMcpTraceSinksForTests({ call: (input) => traces.push(input), catalog: () => {} });
  uploads = [];
  uploadStatus = 200;
  clock = Date.now();
  const root = mkdtempSync(join(tmpdir(), "ravi-mcp-files-ws-"));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  agentRow = { cwd: workspace, remote: null };
  gate = {
    canUseTool: () => true,
    canReadAnywhere: () => false,
    stateDirs: () => [stateDir],
    tempDirs: () => [],
  };
});

afterEach(async () => {
  for (const follower of followers) await follower.stop();
  followers = [];
  for (const gateway of gateways) await gateway.stop();
  gateways = [];
  await fixture?.close();
  fixture = null;
  setMcpUploadTestCaForTests(null);
  setMcpTraceSinksForTests({ call: null, catalog: null });
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  rmSync(join(workspace, ".."), { recursive: true, force: true });
  await cleanupIsolatedRaviState(stateDir);
});

function newGateway(options: McpGatewayOptions = {}): McpGateway {
  const gateway = new McpGateway({
    subscribe: false,
    refreshTickMs: 0,
    authorize,
    closeGraceMs: 200,
    now: () => clock,
    readContext: () => context(),
    elicit: async () => ({ action: "accept", content: { confirm: true } }),
    files: {
      getAgent: () => agentRow,
      gate,
      lookup: publicLookup,
      transport: async (request) => {
        uploads.push(request);
        return { status: uploadStatus };
      },
    },
    ...options,
  });
  gateways.push(gateway);
  return gateway;
}

/** The `console` row on the files fixture, listed by a real refresh (both catalog variants). */
async function registerFilesServer(
  options: Parameters<typeof startFilesFixture>[0] = {},
  attach: { uploads?: boolean } = { uploads: true },
): Promise<McpGateway> {
  fixture = startFilesFixture(options);
  createMcpServer({ name: "console", transport: "http", url: fixture.url, authKind: "none" });
  await writeMcpServerSecret("console", { url: fixture.url });
  const gateway = newGateway();
  const refreshed = await gateway.refresh("console");
  expect(refreshed?.status).toBe("ok");
  attachMcpServer({ agentId: AGENT, server: "console", uploads: attach.uploads === true });
  return gateway;
}

function writeWorkspaceFile(name: string, text: string): string {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
}

function callsOf(tool = "publish"): Array<Record<string, unknown>> {
  return (fixture?.requests ?? [])
    .filter((request) => request.method === "tools/call" && (request.body?.params as { name?: string })?.name === tool)
    .map((request) => request.body!.params as Record<string, unknown>);
}

function textOf(result: McpGatewayCallResult): string {
  if (!result.ok) return result.reason;
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function publish(gateway: McpGateway, args: Record<string, unknown>, detach = false) {
  return gateway.call(
    { context: context(), agentId: AGENT },
    { server: "console", tool: "publish", arguments: args, surface: "cli", budgetMs: 30_000, detach },
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

describe("MCP files: the schema the runtime sees", () => {
  it("rewrites file arguments into path handles and keeps everything else", () => {
    const rewritten = rewriteMcpFileSchema({
      type: "object",
      properties: {
        title: { type: "string" },
        cover: { type: "object", description: "The cover", "x-mcp-file": { maxSize: 1000, accept: ["image/*"] } },
        files: { type: "array", maxItems: 50, items: { type: "object", "x-mcp-file": {} } },
        logo: { anyOf: [{ type: "object", "x-mcp-file": {} }, { type: "null" }] },
      },
    });
    if (!rewritten.ok) throw new Error(rewritten.reason);
    expect(JSON.stringify(rewritten.schema)).not.toContain("x-mcp-file");
    const properties = rewritten.schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.title).toEqual({ type: "string" });
    expect(properties.cover).toEqual({
      type: "string",
      description: `${MCP_FILE_HANDLE_DESCRIPTION} The server says: The cover`,
    });
    expect(properties.files).toMatchObject({ type: "array", items: { type: "string" }, maxItems: 10 });
    expect(rewritten.fileArguments).toEqual([
      { name: "cover", multiple: false, maxSize: 1000, accept: ["image/*"] },
      { name: "files", multiple: true, maxItems: 50 },
      { name: "logo", multiple: false },
    ]);
  });

  it("drops a tool whose file marker sits where Ravi cannot map it", () => {
    for (const schema of [
      { type: "object", "x-mcp-file": {} },
      { type: "object", anyOf: [{ "x-mcp-file": {} }] },
      { type: "object", properties: { deep: { type: "object", properties: { file: { "x-mcp-file": {} } } } } },
      {
        type: "object",
        properties: { mixed: { anyOf: [{ "x-mcp-file": {} }, { type: "array", items: { "x-mcp-file": {} } }] } },
      },
    ]) {
      expect(rewriteMcpFileSchema(schema).ok).toBe(false);
    }
    const built = buildMcpCatalog("console", [
      { name: "bad", inputSchema: { type: "object", "x-mcp-file": {} } },
      { name: "good", inputSchema: { type: "object", properties: { f: { "x-mcp-file": {} } } } },
    ]);
    expect(built.catalog.tools.map((tool) => tool.name)).toEqual(["good"]);
    expect(built.catalog.dropped[0]).toMatchObject({ name: "bad" });
    expect(built.catalog.tools[0]!.fileArguments).toEqual([{ name: "f", multiple: false }]);
  });

  it("lists the files variant only to an attachment with uploads on, without marker or upload detail", async () => {
    await registerFilesServer({}, { uploads: false });
    const server = getMcpServer("console")!;
    const plain = server.catalog!.tools.find((tool) => tool.name === "publish")!;
    expect(Object.keys((plain.inputSchema as { properties: object }).properties)).toEqual(["title", "paths"]);
    expect(plain.fileArguments ?? []).toEqual([]);
    const files = server.filesCatalog!.tools.find((tool) => tool.name === "publish")!;
    expect(Object.keys((files.inputSchema as { properties: object }).properties).sort()).toEqual([
      "files",
      "paths",
      "title",
    ]);
    expect(files.fileArguments).toEqual([
      { name: "files", multiple: true, maxSize: 52_428_800, minItems: 1, maxItems: 10 },
    ]);
    expect(JSON.stringify(server.filesCatalog)).not.toContain("x-mcp-file");

    const seen = () =>
      listAuthorizedMcpTools({ context: context(), agentId: AGENT }, authorize).find(
        (tool) => tool.name === "publish",
      )!;
    expect(Object.keys((seen().inputSchema as { properties: object }).properties)).toEqual(["title", "paths"]);
    updateMcpAttachments({ agentId: AGENT, server: "console", uploads: true });
    expect(mcpCatalogForAttachment(getMcpServer("console")!, getMcpAttachment(AGENT, "console")!)).toEqual(
      getMcpServer("console")!.filesCatalog,
    );
    const withFiles = JSON.stringify(seen());
    expect(withFiles).toContain('"files"');
    expect(withFiles).not.toContain("x-mcp-file");
    expect(withFiles).not.toContain("storage");
  });
});

describe("MCP files: gate A", () => {
  const tool = { name: "publish", fileArguments: [{ name: "files", multiple: true }] };
  const stage = (paths: unknown, deps: McpFileGateDeps = gate) =>
    stageMcpFileArguments(
      { context: context(), agentId: AGENT, cwd: workspace, tool, arguments: { files: paths } },
      deps,
    );

  it("stages workspace files as FileInput with a sha-256 digest", () => {
    writeWorkspaceFile("index.html", "<h1>hi</h1>");
    writeWorkspaceFile("empty.txt", "");
    const staged = stage(["index.html", join(workspace, "empty.txt")]);
    if (!staged.ok) throw new Error(staged.reason);
    expect(staged.arguments.files).toEqual([
      {
        id: "f1",
        mimeType: "text/html",
        size: 11,
        name: "index.html",
        digest: { algorithm: "sha-256", value: sha256("<h1>hi</h1>") },
      },
      {
        id: "f2",
        mimeType: "text/plain",
        size: 0,
        name: "empty.txt",
        digest: { algorithm: "sha-256", value: sha256("") },
      },
    ]);
    expect((staged.arguments.files as Array<{ digest: { value: string } }>)[0]!.digest.value).toHaveLength(43);
    expect(Buffer.from(staged.files[0]!.bytes).toString()).toBe("<h1>hi</h1>");
  });

  it("refuses what the agent may not send, by the real path", () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    symlinkSync(secret, join(workspace, "link.txt"));
    expect(stage([secret])).toMatchObject({ ok: false, code: "outside_workspace" });
    expect(stage(["link.txt"])).toMatchObject({ ok: false, code: "outside_workspace" });
    expect(stage(["../outside/secret.txt"])).toMatchObject({ ok: false, code: "outside_workspace" });

    writeWorkspaceFile("original.txt", "x");
    linkSync(join(workspace, "original.txt"), join(workspace, "second-name.txt"));
    expect(stage(["second-name.txt"])).toMatchObject({ ok: false, code: "hard_link" });

    mkdirSync(join(workspace, ".claude"));
    writeFileSync(join(workspace, ".claude", "settings.json"), "{}");
    expect(stage([".claude/settings.json"])).toMatchObject({ ok: false, code: "provider_config" });
    writeFileSync(join(workspace, ".mcp.json"), "{}");
    expect(stage([".mcp.json"])).toMatchObject({ ok: false, code: "provider_config" });

    writeFileSync(join(stateDir, "ravi.txt"), "state");
    expect(stage([join(stateDir, "ravi.txt")], { ...gate, canReadAnywhere: () => true })).toMatchObject({
      ok: false,
      code: "state_dir",
    });

    writeWorkspaceFile("ok.txt", "fine");
    expect(stage(["ok.txt"], { ...gate, canUseTool: () => false })).toMatchObject({ ok: false, code: "read_denied" });
    expect(stage(["ok.txt"], { ...gate, maxFileBytes: 2 })).toMatchObject({ ok: false, code: "too_large" });
    expect(stage(["art_abc123_def456"])).toMatchObject({ ok: false, code: "artifact_handle" });
    expect(stage([workspace])).toMatchObject({ ok: false, code: "not_a_file" });
    expect(stage("ok.txt")).toMatchObject({ ok: false, code: "invalid_handle" });
    expect(stage(Array.from({ length: 11 }, () => "ok.txt"))).toMatchObject({ ok: false, code: "too_many_files" });
    // A turn that may read anywhere still never sends the state dir or a provider config.
    expect(stage([secret], { ...gate, canReadAnywhere: () => true }).ok).toBe(true);
  });

  it("refuses a file whose directory is swapped for a symlink after the decision", () => {
    mkdirSync(join(workspace, "d"));
    writeFileSync(join(workspace, "d", "secret.txt"), "decoy");
    writeFileSync(join(outside, "secret.txt"), "outside the workspace");
    // The temp-dir lookup runs between the workspace decision and the open, as a process alongside could.
    const swap = () => {
      renameSync(join(workspace, "d"), join(workspace, "d.bak"));
      symlinkSync(outside, join(workspace, "d"));
      return [];
    };
    const raced = stage(["d/secret.txt"], { ...gate, tempDirs: swap });
    expect(raced).toMatchObject({ ok: false, code: "unreadable" });
    expect(JSON.stringify(raced)).not.toContain(outside);

    // The same swap toward the state directory, for a turn that may read anywhere.
    rmSync(join(workspace, "d"));
    renameSync(join(workspace, "d.bak"), join(workspace, "d"));
    writeFileSync(join(stateDir, "secret.txt"), "state");
    const toState = () => {
      renameSync(join(workspace, "d"), join(workspace, "d.bak"));
      symlinkSync(stateDir, join(workspace, "d"));
      return [stateDir];
    };
    expect(stage(["d/secret.txt"], { ...gate, canReadAnywhere: () => true, stateDirs: toState })).toMatchObject({
      ok: false,
      code: "unreadable",
    });
  });

  it("never echoes a resolved location outside the workspace", () => {
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "secret");
    symlinkSync(secret, join(workspace, "innocent.txt"));
    const refused = stage(["innocent.txt"]);
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(outside);
  });
});

describe("MCP files: upload targets", () => {
  const file = {
    fileId: "f1",
    argument: "files",
    name: "index.html",
    mimeType: "text/html",
    size: 3,
    digest: sha256("abc"),
    bytes: new Uint8Array(Buffer.from("abc")),
  };
  const target = (overrides: Record<string, unknown> = {}) => ({
    fileId: "f1",
    url: "https://uploads.storage.test/x?sig=1",
    method: "PUT",
    headers: { "content-type": "text/html", "x-amz-meta-digest": "abc" },
    credentials: "omit",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });

  it("accepts a storage target and keeps signed headers", () => {
    const valid = validateMcpUploadTargets([target()], [file]);
    if (!valid.ok) throw new Error(valid.reason);
    expect(valid.plans[0]!.target.headers).toEqual({ "content-type": "text/html", "x-amz-meta-digest": "abc" });
  });

  it("refuses targets that are not plain https storage", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ url: "http://uploads.storage.test/x" }, "not_https"],
      [{ url: "https://user:pw@uploads.storage.test/x" }, "userinfo"],
      [{ url: "https://10.0.0.5/x" }, "ip_literal"],
      [{ url: "https://[::1]/x" }, "ip_literal"],
      [{ credentials: "include" }, "credentials"],
      [{ credentials: undefined }, "credentials"],
      [{ headers: { authorization: "Bearer x" } }, "credentials"],
      [{ headers: { Cookie: "a=b" } }, "credentials"],
      [{ headers: { "x-forwarded-host": "evil" } }, "credentials"],
      [{ headers: { "bad header": "x" } }, "header"],
      [{ expiresAt: new Date(Date.now() - 1).toISOString() }, "expired"],
      [{ fileId: "f9" }, "unknown_file"],
      [{ path: "/upload/f1" }, "invalid_target"],
      [{ method: "PATCH" }, "invalid_target"],
    ];
    for (const [overrides, code] of cases) {
      const result = validateMcpUploadTargets([target(overrides)], [file]);
      expect({ overrides, code: result.ok ? "ok" : result.code }).toEqual({ overrides, code });
      if (!result.ok) expect(result.reason).not.toContain("storage.test");
    }
    expect(validateMcpUploadTargets([target(), target()], [file]).ok).toBe(false);
  });

  it("judges resolved addresses, not names", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2001:db8::1",
    ]) {
      expect({ address, public: isPublicMcpUploadAddress(address) }).toEqual({ address, public: false });
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect({ address, public: isPublicMcpUploadAddress(address) }).toEqual({ address, public: true });
    }
  });

  it("refuses a name that resolves to any private address, and never follows a redirect", async () => {
    const valid = validateMcpUploadTargets([target()], [file]);
    if (!valid.ok) throw new Error(valid.reason);
    const sent: McpUploadRequest[] = [];
    const transport = async (request: McpUploadRequest) => {
      sent.push(request);
      return { status: 302 };
    };
    const mixed: McpUploadLookup = async () => [
      { address: PUBLIC_ADDRESS, family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    const refused = await performMcpUploads(valid.plans, { lookup: mixed, transport, deadline: Date.now() + 10_000 });
    expect(refused).toMatchObject({ ok: false, code: "private_address" });
    expect(sent).toHaveLength(0);

    const redirected = await performMcpUploads(valid.plans, {
      lookup: publicLookup,
      transport,
      deadline: Date.now() + 10_000,
    });
    expect(redirected).toMatchObject({ ok: false, code: "failed" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.address).toEqual({ address: PUBLIC_ADDRESS, family: 4 });

    const late = await performMcpUploads(valid.plans, {
      lookup: publicLookup,
      transport,
      now: () => Date.now() + 120_000,
      deadline: Date.now() + 300_000,
    });
    expect(late).toMatchObject({ ok: false, code: "expired" });
    expect(sent).toHaveLength(1);
  });

  const openssl = spawnSync("openssl", ["version"]).status === 0;
  it.skipIf(!openssl)(
    "the default transport pins the checked address, checks TLS by name and returns a redirect as is",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "ravi-mcp-tls-"));
      const made = spawnSync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=uploads.storage.test",
        "-addext",
        "subjectAltName=DNS:uploads.storage.test",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ]);
      expect(made.status).toBe(0);
      const cert = readFileSync(join(dir, "cert.pem"), "utf8");
      const seen: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
      const storage = serve({
        port: 0,
        hostname: "127.0.0.1",
        tls: { cert, key: readFileSync(join(dir, "key.pem"), "utf8") },
        async fetch(request) {
          const headers: Record<string, string> = {};
          request.headers.forEach((value, key) => {
            headers[key] = value;
          });
          const path = new URL(request.url).pathname;
          seen.push({ path, headers, body: await request.text() });
          if (path === "/moved") return new Response(null, { status: 302, headers: { location: "/elsewhere" } });
          return new Response("ok");
        },
      });
      try {
        setMcpUploadTestCaForTests(cert);
        const send = (path: string) =>
          httpsMcpUploadTransport({
            url: new URL(`https://uploads.storage.test:${storage.port}${path}?sig=1`),
            method: "PUT",
            headers: { "content-type": "text/html", "x-amz-meta-digest": "abc" },
            body: new Uint8Array(Buffer.from("abc")),
            // The name does not resolve anywhere: only the pinned address is used.
            address: { address: "127.0.0.1", family: 4 },
            timeoutMs: 5_000,
          });
        expect(await send("/up")).toEqual({ status: 200 });
        expect(await send("/moved")).toEqual({ status: 302 });
        expect(seen.map((request) => request.path)).toEqual(["/up", "/moved"]);
        expect(seen[0]!.body).toBe("abc");
        // Exactly the listed headers plus what the client needs, with a user agent that names no runtime.
        expect(Object.keys(seen[0]!.headers).sort()).toEqual([
          "accept",
          "content-length",
          "content-type",
          "host",
          "user-agent",
          "x-amz-meta-digest",
        ]);
        expect(seen[0]!.headers["user-agent"]).toBe("Ravi");
        expect(seen[0]!.headers.accept).toBe("*/*");
        expect(seen[0]!.headers.authorization).toBeUndefined();
        expect(seen[0]!.headers.cookie).toBeUndefined();
        expect(
          Object.keys(seen[0]!.headers).filter((name) => name.startsWith("mcp") || name.startsWith("x-ravi")),
        ).toEqual([]);
        // A certificate for another name is refused.
        setMcpUploadTestCaForTests(null);
        await expect(send("/up")).rejects.toBeDefined();
      } finally {
        storage.stop(true);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("MCP files: calls through the gateway", () => {
  it("confirms, uploads to storage with only the listed headers, and retries once with the request state", async () => {
    const gateway = await registerFilesServer({ tasks: false });
    writeWorkspaceFile("index.html", "<h1>site</h1>");
    writeWorkspaceFile("style.css", "h1{}");
    writeWorkspaceFile("empty.txt", "");
    const result = await publish(gateway, { title: "Site", files: ["index.html", "style.css", "empty.txt"] });
    expect(result.ok && result.outcome).toBe("ok");
    expect(textOf(result)).toBe("published Site with 3 file(s)");

    const calls = callsOf();
    expect(calls).toHaveLength(3);
    const sentFiles = (calls[0]!.arguments as { files: Array<Record<string, unknown>> }).files;
    expect(sentFiles.map((item) => item.id)).toEqual(["f1", "f2", "f3"]);
    expect(sentFiles[0]).toEqual({
      id: "f1",
      mimeType: "text/html",
      size: 13,
      name: "index.html",
      digest: { algorithm: "sha-256", value: sha256("<h1>site</h1>") },
    });
    expect(JSON.stringify(calls)).not.toContain(workspace);
    // The confirmation answer went with the second request; the retry carries the state and nothing else.
    expect(calls[1]!.inputResponses).toBeDefined();
    expect(Object.keys(calls[2]!).sort()).toEqual(["_meta", "arguments", "name", "requestState"]);
    expect(calls[2]!.arguments).toEqual(calls[0]!.arguments);
    expect(String(calls[2]!.requestState)).toStartWith("rmc2.upload.");
    const declared = (calls[0]!._meta as Record<string, { extensions?: Record<string, unknown> }>)[
      "io.modelcontextprotocol/clientCapabilities"
    ]!.extensions!;
    expect(declared["io.modelcontextprotocol/files"]).toEqual({ upload: {} });

    // The empty file needed no upload; the two others went to storage, pinned, with the listed headers only.
    expect(uploads.map((upload) => upload.url.pathname)).toEqual(["/r/2/f1", "/r/2/f2"]);
    for (const upload of uploads) {
      expect(upload.method).toBe("PUT");
      expect(upload.address).toEqual({ address: PUBLIC_ADDRESS, family: 4 });
      expect(Object.keys(upload.headers).sort()).toEqual(["content-type", "x-amz-meta-digest"]);
    }
    expect(Buffer.from(uploads[0]!.body).toString()).toBe("<h1>site</h1>");
    expect(fixture!.published).toHaveLength(1);

    // The trace holds counts and sizes only.
    expect(traces.at(-1)).toMatchObject({ outcome: "ok", upload: { files: 2, bytes: 17, outcome: "sent" } });
    const leaked = JSON.stringify([traces, result]);
    for (const secret of ["storage.test", "rmc2", "sig=", "x-mcp-file", "<h1>site</h1>", workspace]) {
      expect(leaked).not.toContain(secret);
    }
  });

  it("hands the task the retry answers to the follower, whose polls declare files too", async () => {
    const gateway = await registerFilesServer({ tasks: true });
    const follower = new McpCallFollower({ gateway, now: () => clock, tickMs: 0, publish: async () => {} });
    followers.push(follower);
    gateway.attachCallSink(follower);
    writeWorkspaceFile("index.html", "<p>x</p>");
    const result = await publish(gateway, { title: "Site", files: ["index.html"] }, true);
    expect(result.ok && result.outcome).toBe("detached");
    if (!result.ok) throw new Error(result.reason);
    expect(result.detachReason).toBe("task");
    const id = result.callId!;
    expect(getMcpCall(id)).toMatchObject({ state: "task", filesUpload: true });
    expect(uploads).toHaveLength(1);

    clock = (getMcpCall(id)!.nextPollAt ?? clock) + 1;
    await follower.tick();
    await follower.idle();
    const polls = fixture!.requests.filter((request) => request.method === "tasks/get");
    expect(polls.length).toBeGreaterThan(0);
    const meta = (polls[0]!.body!.params as { _meta: Record<string, { extensions: Record<string, unknown> }> })._meta;
    expect(meta["io.modelcontextprotocol/clientCapabilities"]!.extensions["io.modelcontextprotocol/files"]).toEqual({
      upload: {},
    });
    expect(callsOf()).toHaveLength(3);
  });

  it("a file call that cannot leave its turn declares no tasks on any request, so the server answers inline", async () => {
    const gateway = await registerFilesServer({ tasks: true });
    writeWorkspaceFile("index.html", "<p>x</p>");
    const declaredOf = (params: Record<string, unknown>) =>
      (params._meta as Record<string, { extensions?: Record<string, unknown> }>)[
        "io.modelcontextprotocol/clientCapabilities"
      ]!.extensions ?? {};

    // No follower attached: the call asks to detach but cannot.
    const unfollowed = await publish(gateway, { title: "Site", files: ["index.html"] }, true);
    expect(unfollowed.ok && unfollowed.outcome).toBe("ok");
    expect(textOf(unfollowed)).toBe("published Site with 1 file(s)");

    // A follower attached, but the call does not ask to detach (a terminal call, a turn without a session).
    const follower = new McpCallFollower({ gateway, now: () => clock, tickMs: 0, publish: async () => {} });
    followers.push(follower);
    gateway.attachCallSink(follower);
    const inline = await publish(gateway, { title: "Site", files: ["index.html"] }, false);
    expect(inline.ok && inline.outcome).toBe("ok");
    expect(textOf(inline)).toBe("published Site with 1 file(s)");

    const calls = callsOf();
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      expect(declaredOf(call)["io.modelcontextprotocol/tasks"]).toBeUndefined();
      expect(declaredOf(call)["io.modelcontextprotocol/files"]).toEqual({ upload: {} });
    }
    expect(fixture!.published).toHaveLength(2);
    expect(fixture!.requests.some((request) => request.method === "tasks/get")).toBe(false);
  });

  it("never sends the retry again when its outcome is unknown, or when the state was already used", async () => {
    const gateway = await registerFilesServer({ tasks: false, dropRetry: true });
    writeWorkspaceFile("index.html", "<p>x</p>");
    const dropped = await publish(gateway, { title: "Site", files: ["index.html"] });
    expect(dropped.ok).toBe(false);
    expect(textOf(dropped)).toContain("outcome on the server is unknown");
    expect(textOf(dropped)).toContain("It was not sent again.");
    expect(callsOf()).toHaveLength(3);

    fixture!.setOptions({
      dropRetry: false,
      retryError: { status: 200, code: -32602, message: "Invalid or expired requestState" },
    });
    const used = await publish(gateway, { title: "Site", files: ["index.html"] });
    expect(used.ok).toBe(false);
    expect(textOf(used)).toContain("It was not sent again.");
    expect(callsOf()).toHaveLength(6);
  });

  it("reports a retry refused before it ran (429) as nothing ran, and never resends it", async () => {
    const gateway = await registerFilesServer({
      tasks: false,
      retryError: { status: 429, code: -32000, message: "Too many requests", retryAfter: "7" },
    });
    writeWorkspaceFile("index.html", "<p>x</p>");
    const limited = await publish(gateway, { title: "Site", files: ["index.html"] });
    expect(limited).toMatchObject({ ok: false, outcome: "error" });
    expect(textOf(limited)).toContain("nothing ran; try again in 7 s");
    expect(textOf(limited)).toContain("uploads the files again");
    expect(textOf(limited)).not.toContain("used up");
    expect(textOf(limited)).toContain("It was not sent again.");
    expect(callsOf()).toHaveLength(3);
    expect(fixture!.published).toHaveLength(0);
  });

  it("sends no retry when a target is refused or the upload fails", async () => {
    const gateway = await registerFilesServer({
      tasks: false,
      target: (upload) => ({ ...upload, url: upload.url.replace("https:", "http:") }),
    });
    writeWorkspaceFile("index.html", "<p>x</p>");
    const refused = await publish(gateway, { title: "Site", files: ["index.html"] });
    expect(refused.ok).toBe(false);
    expect(textOf(refused)).toContain("not https");
    expect(textOf(refused)).not.toContain("storage.test");
    expect(uploads).toHaveLength(0);
    expect(callsOf()).toHaveLength(2);
    expect(traces.at(-1)).toMatchObject({ upload: { files: 0, bytes: 0, outcome: "refused" } });

    fixture!.setOptions({ target: (upload) => ({ ...upload, expiresAt: new Date(Date.now() - 1000).toISOString() }) });
    expect(textOf(await publish(gateway, { title: "Site", files: ["index.html"] }))).toContain("expired");
    expect(uploads).toHaveLength(0);

    fixture!.setOptions({ target: undefined });
    uploadStatus = 403;
    const failed = await publish(gateway, { title: "Site", files: ["index.html"] });
    expect(textOf(failed)).toContain("HTTP 403");
    expect(uploads).toHaveLength(1);
    expect(callsOf()).toHaveLength(6);
    expect(fixture!.published).toHaveLength(0);
  });

  it("gate B refuses before any request: uploads off, a remote agent, a server without uploads", async () => {
    const gateway = await registerFilesServer({ tasks: false });
    writeWorkspaceFile("index.html", "<p>x</p>");
    const before = fixture!.requests.length;

    // The plain catalog has no file argument: the path goes out as a plain argument only when uploads are on.
    updateMcpAttachments({ agentId: AGENT, server: "console", uploads: true });
    agentRow = { cwd: workspace, remote: "worker-1" };
    expect(await publish(gateway, { title: "Site", files: ["index.html"] })).toMatchObject({
      ok: false,
      outcome: "file_refused",
      code: "remote_agent",
    });

    agentRow = { cwd: workspace, remote: null };
    writeFileSync(join(outside, "x.txt"), "x");
    expect(await publish(gateway, { title: "Site", files: [join(outside, "x.txt")] })).toMatchObject({
      ok: false,
      outcome: "file_refused",
      code: "outside_workspace",
    });
    expect(fixture!.requests.length).toBe(before);
    expect(uploads).toHaveLength(0);
    expect(traces.at(-1)).toMatchObject({ outcome: "file_refused", upload: { outcome: "refused" } });
    // A legacy server never takes files: the attachment sees the plain catalog, so nothing is read or uploaded.
    recordMcpServerProbe("console", { status: "ok", era: "legacy" });
    expect(mcpCatalogForAttachment(getMcpServer("console")!, getMcpAttachment(AGENT, "console")!)).toEqual(
      getMcpServer("console")!.catalog,
    );
    expect(await publish(gateway, { title: "Site", files: ["index.html"] })).toMatchObject({ ok: false });
    expect(uploads).toHaveLength(0);
    expect(JSON.stringify(fixture!.requests)).not.toContain('"digest"');
  });

  it("an attachment with uploads off sees no file argument and refuses one by name", async () => {
    const gateway = await registerFilesServer({ tasks: false }, { uploads: false });
    const server = getMcpServer("console")!;
    // A stale call naming a file argument of the files variant is refused by gate B.
    recordMcpServerProbe("console", { status: "ok", catalog: server.filesCatalog });
    writeWorkspaceFile("index.html", "<p>x</p>");
    const before = fixture!.requests.length;
    const refused = await publish(gateway, { title: "Site", files: ["index.html"] });
    expect(refused).toMatchObject({ ok: false, outcome: "file_refused", code: "uploads_off" });
    expect(textOf(refused)).toContain("--uploads on");
    expect(fixture!.requests.length).toBe(before);
  });

  it("a server that needs files the call did not declare answers -32021, reported as an uploads hint", async () => {
    const gateway = await registerFilesServer({ tasks: true }, { uploads: false });
    const follower = new McpCallFollower({ gateway, now: () => clock, tickMs: 0, publish: async () => {} });
    followers.push(follower);
    gateway.attachCallSink(follower);
    const result = await publish(gateway, { title: "Site", files: [{ id: "f1", size: 1 }] }, true);
    expect(result.ok).toBe(false);
    expect(textOf(result)).toContain("needs file uploads");
    expect(textOf(result)).toContain("--uploads on");
    expect(uploads).toHaveLength(0);
  });
});

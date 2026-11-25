/**
 * Remote skills of MCP servers (spec mcp, Remote Skills).
 *
 * Commands run where the daemon runs them: over a real host CLI gateway
 * socket to `McpSkillsCommands`, which uses the daemon's MCP gateway against
 * a skills fixture server (SDK 2.4.0 skills extension). The Library side (the
 * generated plugin, the per-turn gate, the allowlist and a Console sync) is
 * checked against the same state.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { McpCommands, McpSkillsCommands } from "../cli/commands/mcp.js";
import { type HostCliGatewayHandle, startHostCliGateway } from "../cli/host-cli-gateway.js";
import { buildRegistry } from "../cli/registry-snapshot.js";
import { dispatchRemote, type RemoteGatewayConfig } from "../cli/remote-gateway.js";
import { dbSetLibraryAgentListed } from "../library/agents-db.js";
import { dbGetLibraryPinState, readAgentLibraryPins } from "../library/pins-db.js";
import { setLibraryConfigChangedEmitterForTests, syncLibraryPins } from "../library/pins.js";
import { libraryAgentPluginDir, libraryUnionPluginDir } from "../library/plugin.js";
import { isMcpSkillId, isLibrarySkillId } from "../library/refs.js";
import { isLibraryPluginSkillAllowedForTurn, resolveLibrarySessionPlugins } from "../library/session-plugins.js";
import { createFakeConsole, fakeSession, fakeSkill } from "../library/test-fixtures.js";
import { setPermissionAuditPublisherForTest } from "../permissions/denials.js";
import { type ContextCapability, type ContextRecord, dbCreateAgent, dbGetAgent, getDb } from "../router/router-db.js";
import { ADMIN_BOOTSTRAP_KIND, createRuntimeContext } from "../runtime/context-registry.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { mcpServerCallSummary, recordMcpServerRateLimit } from "./calls-db.js";
import { getMcpGateway, MCP_GATEWAY_STOP_WAIT_MS, startMcpGateway, stopMcpGateway } from "./gateway.js";
import {
  attachMcpServer,
  createMcpServer,
  getMcpServer,
  setMcpConfigChangedEmitterForTests,
  updateMcpServerConfig,
} from "./registry-db.js";
import { type McpServerSecret, writeMcpServerSecret } from "./secrets.js";
import {
  assignMcpSkillPluginName,
  canonicalMcpSkillManifest,
  cleanMcpSkillText,
  MCP_SKILL_NAME_MAX,
  mcpSkillManifestDigest,
  mcpSkillStubMarkdown,
  mcpSkillUriFromArg,
  normalizeMcpSkillFileRef,
  parseMcpSkillId,
} from "./skill-ids.js";
import { getMcpSkillPin, listMcpSkillPins, upsertMcpSkillPin } from "./skill-pins-db.js";
import { mcpSkillsScopeStatus } from "./skills.js";
import { type McpSkillTraceInput, setMcpTraceSinksForTests } from "./trace.js";
import {
  fixtureSkillUri,
  FIXTURE_SKILL_FILES,
  type SkillsFixture,
  startSkillsFixture,
} from "./test-fixtures/skills-server.js";

const RUNTIME_ENV = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_GATEWAY_URL",
  "RAVI_SUPPRESS_AUDIT_EVENTS",
] as const;

const WEEKLY = "mcp:docs:project/prs/weekly-report";
const STUB = "mcp-docs-weekly-report";

let stateDir: string;
let savedEnv: Record<string, string | undefined> = {};
let fixture: SkillsFixture | null = null;
let socket: HostCliGatewayHandle | null = null;
let config: RemoteGatewayConfig;

beforeEach(async () => {
  stateDir = (await createIsolatedRaviState("ravi-mcp-skills-")) as string;
  savedEnv = Object.fromEntries(RUNTIME_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENV) delete process.env[name];
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
  setMcpConfigChangedEmitterForTests(() => {});
  setLibraryConfigChangedEmitterForTests(() => {});
  setPermissionAuditPublisherForTest(() => {});
  for (const id of ["main", "other"]) {
    if (!dbGetAgent(id)) dbCreateAgent({ id, cwd: stateDir });
  }
});

afterEach(async () => {
  setMcpTraceSinksForTests({ skill: null });
  await socket?.stop();
  socket = null;
  await stopMcpGateway();
  await fixture?.close();
  fixture = null;
  setPermissionAuditPublisherForTest();
  setMcpConfigChangedEmitterForTests(null);
  setLibraryConfigChangedEmitterForTests(null);
  for (const name of RUNTIME_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await cleanupIsolatedRaviState(stateDir);
});

/** The skills fixture registered as `docs`, attached to `main` (and `other`) with the given audience. */
async function startDaemon(
  audience: "operator" | "any" = "operator",
  authKind: "none" | "bearer" = "none",
): Promise<void> {
  fixture = await startSkillsFixture();
  createMcpServer({ name: "docs", transport: "http", url: fixture.url, authKind, protocol: "2026-07-28" });
  await writeMcpServerSecret("docs", { url: fixture.url, ...(authKind === "bearer" ? { bearer: "tok_docs" } : {}) });
  attachMcpServer({ agentId: "main", server: "docs", audience });
  attachMcpServer({ agentId: "other", server: "docs", audience });
  const gateway = await startMcpGateway({ subscribe: false, refreshTickMs: 0, closeGraceMs: 200 });
  const row = await gateway.refresh("docs");
  expect(row?.status).toBe("ok");
  const socketPath = join(stateDir, "cli-gateway.sock");
  socket = await startHostCliGateway({
    socketPath,
    gateway: { registry: buildRegistry([McpCommands, McpSkillsCommands]) },
  });
  expect(socket).not.toBeNull();
  config = { url: `unix://${socketPath}`, source: "env", socketPath };
}

const SKILL_CAPS: ContextCapability[] = [
  { permission: "read", objectType: "mcp.skills", objectId: "list", source: "test" },
  { permission: "read", objectType: "mcp.skills", objectId: "read", source: "test" },
];

function operatorContext(agentId = "main"): ContextRecord {
  return createRuntimeContext({
    kind: ADMIN_BOOTSTRAP_KIND,
    agentId,
    capabilities: [{ permission: "admin", objectType: "system", objectId: "*", source: "test" }],
  });
}

/** The pin and unpin grants, so the command itself (not the capability check) decides. */
const MUTATE_CAPS: ContextCapability[] = [
  { permission: "mutate", objectType: "mcp.skills", objectId: "pin", source: "test" },
  { permission: "mutate", objectType: "mcp.skills", objectId: "unpin", source: "test" },
];

function contactContext(extra: ContextCapability[] = []): ContextRecord {
  return createRuntimeContext({
    kind: "agent-runtime",
    agentId: "main",
    sessionName: "main-ana",
    capabilities: [...SKILL_CAPS, ...extra],
    metadata: {
      actorPrincipal: "contact:c_ana",
      actorResolution: "resolved",
      executorAgentId: "main",
      consoleUserId: "user_ana",
      agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
    },
  });
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function remote(context: ContextRecord, command: string, body: Record<string, unknown>): Promise<Answer> {
  const result = await dispatchRemote({
    groupSegments: ["mcp", "skills"],
    command,
    body,
    config,
    contextKey: context.contextKey,
    timeoutMs: 30_000,
  });
  return { status: result.status, body: JSON.parse(result.body) as Record<string, unknown> };
}

function errorOf(answer: Answer): { code: string; exitCode: number; message: string; plan?: Record<string, unknown> } {
  expect(answer.body.success).toBe(false);
  const error = answer.body.error as Record<string, unknown>;
  return {
    code: error.code as string,
    exitCode: answer.body.exitCode as number,
    message: error.message as string,
    plan: error.plan as Record<string, unknown> | undefined,
  };
}

function reads(): string[] {
  return fixture?.reads ?? [];
}

async function pinWeekly(extra: Record<string, unknown> = {}): Promise<Answer> {
  return remote(operatorContext(), "pin", { server: "docs", skill: WEEKLY, execute: true, ...extra });
}

function generationSkills(agentId: string, variant: "all" | "external"): string[] {
  const dir = dbGetLibraryPinState()?.pluginDir;
  if (!dir) return [];
  const skills = join(libraryAgentPluginDir(dir, agentId, variant), "skills");
  return existsSync(skills) ? readdirSync(skills).sort() : [];
}

describe("remote skill ids, names and stubs", () => {
  it("derives the id from the URI path and parses it back", () => {
    const ref = parseMcpSkillId(WEEKLY);
    expect(ref).toEqual({
      server: "docs",
      path: "project/prs/weekly-report",
      uri: "skill://project/prs/weekly-report/SKILL.md",
      id: WEEKLY,
    });
    for (const bad of ["docs:x", "mcp:Docs:x", "mcp:docs:", "mcp:docs:a/../b", "mcp:docs:a//b", "mcp:docs:a b"]) {
      expect(() => parseMcpSkillId(bad)).toThrow();
    }
    expect(mcpSkillUriFromArg("docs", "project/prs/weekly-report")).toBe(fixtureSkillUri("weekly-report"));
    expect(mcpSkillUriFromArg("docs", fixtureSkillUri("weekly-report"))).toBe(fixtureSkillUri("weekly-report"));
    expect(() => mcpSkillUriFromArg("docs", "mcp:other:project/x")).toThrow();
    expect(() => mcpSkillUriFromArg("docs", "https://example.com/SKILL.md")).toThrow();
  });

  it("refuses path traversal and odd forms in --file", () => {
    expect(normalizeMcpSkillFileRef(undefined)).toBe("SKILL.md");
    expect(normalizeMcpSkillFileRef("references/GUIDE.md")).toBe("references/GUIDE.md");
    for (const bad of [
      "../SKILL.md",
      "references/../../x",
      "/etc/passwd",
      "./GUIDE.md",
      "references//GUIDE.md",
      "%2e%2e/x",
      "references\\GUIDE.md",
      "file:///etc/passwd",
      "skill://other/SKILL.md",
      "a\u0000b",
      "",
    ]) {
      expect(() => normalizeMcpSkillFileRef(bad)).toThrow();
    }
  });

  it("keeps plugin names within 64 characters and hashes a collision or a long name", () => {
    const uri = fixtureSkillUri("weekly-report");
    expect(assignMcpSkillPluginName("docs", uri, new Set())).toBe(STUB);
    const collided = assignMcpSkillPluginName("docs", uri, new Set([STUB]));
    expect(collided).toMatch(/^mcp-docs-weekly-report-[0-9a-f]{8}$/);
    const long = assignMcpSkillPluginName("a".repeat(24), `skill://x/${"b".repeat(90)}/SKILL.md`, new Set());
    expect(long.length).toBeLessThanOrEqual(MCP_SKILL_NAME_MAX);
    expect(long).toMatch(/-[0-9a-f]{8}$/);
  });

  it("binds a digest to the manifest whatever the order of its files, and a dynamic list has none", () => {
    const entry = {
      uri: fixtureSkillUri("weekly-report"),
      frontmatter: { name: "weekly-report", description: "d" },
      resources: [
        { uri: fixtureSkillUri("weekly-report", "b.md"), digest: `sha256:${"b".repeat(64)}`, size: 2 },
        { uri: fixtureSkillUri("weekly-report"), digest: `sha256:${"a".repeat(64)}`, size: 1 },
      ],
    };
    const reversed = { ...entry, resources: [...entry.resources].reverse() };
    const a = canonicalMcpSkillManifest(entry)!;
    expect(mcpSkillManifestDigest(a)).toBe(mcpSkillManifestDigest(canonicalMcpSkillManifest(reversed)!));
    const changed = { ...entry, resources: [{ ...entry.resources[0]!, size: 3 }, entry.resources[1]!] };
    expect(mcpSkillManifestDigest(canonicalMcpSkillManifest(changed)!)).not.toBe(mcpSkillManifestDigest(a));
    expect(canonicalMcpSkillManifest({ ...entry, resources: "dynamic" })).toBeNull();
  });

  it("writes a stub with no remote instructions and a cleaned, quoted description", () => {
    const stub = mcpSkillStubMarkdown({
      skillName: STUB,
      skillId: WEEKLY,
      server: "docs",
      name: "weekly\nreport",
      description: 'Line one\n---\nname: evil‮ "quoted"',
    });
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(stub)![1]!;
    expect(frontmatter.split("\n")).toHaveLength(2);
    expect(frontmatter).toContain(`name: ${STUB}`);
    expect(frontmatter).not.toContain("name: evil\n");
    expect(stub).not.toContain("‮");
    expect(stub).toContain(`ravi mcp skills read ${WEEKLY}`);
    expect(cleanMcpSkillText("a\u0007b c", 100)).toBe("a b c");
  });

  it("treats mcp: ids as never naming a local skill", () => {
    expect(isMcpSkillId(WEEKLY)).toBe(true);
    expect(isLibrarySkillId(WEEKLY)).toBe(true);
    expect(isLibrarySkillId("mcp-docs-weekly-report")).toBe(false);
  });
});

describe("ravi mcp skills through the host gateway socket", () => {
  it("lists manifests only, with ids, and fetches no file", async () => {
    await startDaemon();
    const answer = await remote(operatorContext(), "list", { server: "docs" });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ server: "docs", supported: true, total: 2, invalid: 0 });
    const skills = answer.body.skills as Array<Record<string, unknown>>;
    expect(skills.map((skill) => skill.id)).toEqual(["mcp:docs:project/prs/pdf-forms", WEEKLY]);
    expect(skills[1]).toMatchObject({ name: "weekly-report", files: 2, dynamic: false, pins: [] });
    expect(fixture!.methods).not.toContain("resources/read");
  });

  it("pins without any resources/read: a dry run (exit 3, nothing stored), then --execute", async () => {
    await startDaemon();
    const dry = errorOf(await remote(operatorContext(), "pin", { server: "docs", skill: WEEKLY }));
    expect(dry.exitCode).toBe(3);
    expect(dry.plan).toMatchObject({ id: WEEKLY, skill: STUB, files: 2, fetchesFiles: false, alreadyPinned: false });
    expect(getMcpSkillPin("main", "docs", fixtureSkillUri("weekly-report"))).toBeNull();

    const pinned = await pinWeekly({ digest: dry.plan!.manifestDigest });
    expect(pinned.status).toBe(200);
    expect(pinned.body).toMatchObject({ pinned: true, created: true, id: WEEKLY, skill: STUB, pluginRebuilt: true });
    expect(reads()).toEqual([]);
    expect(fixture!.methods).not.toContain("resources/read");

    const row = getMcpSkillPin("main", "docs", fixtureSkillUri("weekly-report"))!;
    expect(row).toMatchObject({ state: "active", externalAllowed: false, skillName: STUB, skillId: WEEKLY });
    expect(row.manifestDigest).toBe(dry.plan!.manifestDigest as string);
    // The stub is in the agent's `all` plugin only (not external), and holds no remote text but the description.
    expect(generationSkills("main", "all")).toEqual([STUB]);
    expect(generationSkills("main", "external")).toEqual([]);
    const stub = readFileSync(
      join(libraryAgentPluginDir(dbGetLibraryPinState()!.pluginDir!, "main", "all"), "skills", STUB, "SKILL.md"),
      "utf8",
    );
    expect(stub).toContain(`name: ${STUB}`);
    expect(stub).toContain(`ravi mcp skills read ${WEEKLY}`);
    expect(stub).not.toContain("Use short sentences");
  });

  it("refuses a pin from a contact's turn, a stale --digest, a dynamic list, and a Library duplicate", async () => {
    await startDaemon("any");
    const ungranted = errorOf(await remote(contactContext(), "pin", { server: "docs", skill: WEEKLY, execute: true }));
    expect(ungranted.code).toBe("PERMISSION_DENIED");
    const contact = errorOf(
      await remote(contactContext(MUTATE_CAPS), "pin", { server: "docs", skill: WEEKLY, execute: true }),
    );
    expect(contact.exitCode).toBe(3);
    expect(contact.code).toBe("OPERATOR_TURN_REQUIRED");

    const stale = errorOf(await pinWeekly({ digest: `sha256:${"0".repeat(64)}` }));
    expect(stale.code).toBe("MCP_SKILL_MANIFEST_CHANGED");

    fixture!.dynamic(fixtureSkillUri("weekly-report"));
    const dynamic = errorOf(await pinWeekly());
    expect(dynamic.code).toBe("MCP_SKILL_DYNAMIC");
    fixture!.dynamic(null);

    // The agent already gets prs/weekly-report from a Console Library pin.
    const fake = createFakeConsole([fakeSkill({ slug: "weekly-report", project: "prs", version: 3 })]);
    fake.pins.push({
      id: "pin-1",
      installationId: "inst-1",
      agentId: "main",
      scope: "project",
      project: "prs",
      slug: "weekly-report",
      pinnedBy: "Op",
    });
    dbSetLibraryAgentListed("main", true);
    await syncLibraryPins(fakeSession(fake), { report: false }, { emitConfigChanged: () => {} });
    fixture!.libraryRef(fixtureSkillUri("weekly-report"), "prs/weekly-report");
    const duplicate = errorOf(await pinWeekly());
    expect(duplicate.code).toBe("MCP_SKILL_LIBRARY_DUPLICATE");
    // Another agent without that Library pin may pin it.
    const other = await remote(operatorContext("other"), "pin", { server: "docs", skill: WEEKLY, execute: true });
    expect(other.status).toBe(200);
    expect(listMcpSkillPins()).toHaveLength(1);
    expect(reads()).toEqual([]);
  });

  it("reads SKILL.md and a listed file with digest checks, then serves them from the cache by digest", async () => {
    await startDaemon();
    await pinWeekly();
    const first = await remote(operatorContext(), "read", { id: WEEKLY });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ id: WEEKLY, file: "SKILL.md", cached: false, binary: false, truncated: false });
    expect(first.body.text).toBe(FIXTURE_SKILL_FILES["weekly-report/SKILL.md"]);
    expect(reads()).toEqual([fixtureSkillUri("weekly-report")]);

    const again = await remote(operatorContext(), "read", { id: WEEKLY });
    expect(again.body).toMatchObject({ cached: true, text: FIXTURE_SKILL_FILES["weekly-report/SKILL.md"] });
    expect(reads()).toHaveLength(1);
    const hex = (first.body.digest as string).slice("sha256:".length);
    expect(existsSync(join(stateDir, "mcp", "skills", "cache", hex))).toBe(true);

    const guide = await remote(operatorContext(), "read", { id: WEEKLY, file: "references/GUIDE.md" });
    expect(guide.body).toMatchObject({ file: "references/GUIDE.md", text: "# Guide\nUse short sentences.\n" });
  });

  it("answers a login without the skills scope as a skills error: the row keeps its status and its tools work", async () => {
    await startDaemon("operator", "bearer");
    await pinWeekly();
    // A Console answers skills/get and resources/read without the skills scope with 403 insufficient_scope.
    fixture!.refuse(["skills/get", "resources/read"]);
    const pin = errorOf(await remote(operatorContext(), "pin", { server: "docs", skill: WEEKLY }));
    expect(pin.code).toBe("MCP_SKILLS_SCOPE_MISSING");
    const read = errorOf(await remote(operatorContext(), "read", { id: WEEKLY }));
    expect(read.code).toBe("MCP_SKILLS_SCOPE_MISSING");
    expect(getMcpServer("docs")?.status).toBe("ok");
    const call = await getMcpGateway()!.call(
      { context: operatorContext(), agentId: "main" },
      { server: "docs", tool: "noop", surface: "cli" },
    );
    expect(call.ok && call.outcome).toBe("ok");

    // A 429 on a skills method is recorded for ravi mcp show.
    fixture!.refuse(["skills/get"], "rate_limited");
    const limited = errorOf(await remote(operatorContext(), "pin", { server: "docs", skill: WEEKLY }));
    expect(limited.code).toBe("MCP_SKILLS_RATE_LIMITED");
    expect(mcpServerCallSummary("docs").rateLimitedMethod).toBe("skills/get");
    expect(getMcpServer("docs")?.status).toBe("ok");
  });

  it("refuses --file traversal and unlisted files before any network use", async () => {
    await startDaemon();
    await pinWeekly();
    const before = fixture!.methods.length;
    for (const file of ["../pdf-forms/SKILL.md", "/etc/passwd", "references/../../x"]) {
      const answer = errorOf(await remote(operatorContext(), "read", { id: WEEKLY, file }));
      expect(answer.exitCode).toBe(2);
      expect(answer.code).toBe("MCP_SKILL_FILE_INVALID");
    }
    const unlisted = errorOf(await remote(operatorContext(), "read", { id: WEEKLY, file: "references/OTHER.md" }));
    expect(unlisted.code).toBe("MCP_SKILL_FILE_NOT_FOUND");
    expect(fixture!.methods.length).toBe(before);
  });

  it("refuses bytes that miss the manifest digest, marks the pin stale and drops its stub", async () => {
    await startDaemon();
    await pinWeekly();
    fixture!.tamper(fixtureSkillUri("weekly-report", "references/GUIDE.md"));
    const bad = errorOf(await remote(operatorContext(), "read", { id: WEEKLY, file: "references/GUIDE.md" }));
    expect(bad.code).toBe("MCP_SKILL_DIGEST_MISMATCH");
    expect(bad.message).not.toContain("short sentences");
    expect(getMcpSkillPin("main", "docs", fixtureSkillUri("weekly-report"))).toMatchObject({
      state: "stale",
      staleReason: "digest_mismatch",
    });
    expect(generationSkills("main", "all")).toEqual([]);
    const after = errorOf(await remote(operatorContext(), "read", { id: WEEKLY }));
    expect(after.code).toBe("MCP_SKILL_STALE");
  });

  it("marks a pin stale when the server's manifest changes (read and list), until it is pinned again", async () => {
    await startDaemon();
    await pinWeekly();
    await remote(operatorContext("other"), "pin", { server: "docs", skill: WEEKLY, execute: true });
    await fixture!.setFiles({
      ...FIXTURE_SKILL_FILES,
      "weekly-report/SKILL.md": "---\nname: weekly-report\ndescription: Write the weekly report.\n---\n# Changed\n",
    });
    const changed = errorOf(await remote(operatorContext(), "read", { id: WEEKLY }));
    expect(changed.code).toBe("MCP_SKILL_STALE");
    expect(reads()).toEqual([]);
    // Every agent's pin on the old manifest goes stale, and the stub leaves the plugin.
    expect(listMcpSkillPins().map((pin) => [pin.agentId, pin.state, pin.staleReason])).toEqual([
      ["main", "stale", "manifest_changed"],
      ["other", "stale", "manifest_changed"],
    ]);
    expect(generationSkills("main", "all")).toEqual([]);

    const repinned = await pinWeekly();
    expect(repinned.body).toMatchObject({ created: false });
    expect(getMcpSkillPin("main", "docs", fixtureSkillUri("weekly-report"))?.state).toBe("active");
    const read = await remote(operatorContext(), "read", { id: WEEKLY });
    expect(read.body.text).toContain("# Changed");

    await fixture!.setFiles(FIXTURE_SKILL_FILES);
    const listed = await remote(operatorContext(), "list", { server: "docs" });
    expect(listed.body.stalePins).toEqual([{ agent: "main", id: WEEKLY, reason: "manifest_changed" }]);
  });

  it("applies the per-turn gate to a read: an operator-only pin is denied on a contact turn, an external one is read", async () => {
    await startDaemon("any");
    await pinWeekly();
    const denied = errorOf(await remote(contactContext(), "read", { id: WEEKLY }));
    expect(denied.exitCode).toBe(3);
    expect(denied.code).toBe("MCP_SKILL_EXTERNAL_DENIED");
    expect(reads()).toEqual([]);

    await pinWeekly({ external: true });
    const allowed = await remote(contactContext(), "read", { id: WEEKLY });
    expect(allowed.status).toBe(200);
    expect(allowed.body.text).toBe(FIXTURE_SKILL_FILES["weekly-report/SKILL.md"]);
  });

  it("still needs the server's audience: an external pin on an operator-audience server is not read by a contact", async () => {
    await startDaemon("operator");
    await pinWeekly({ external: true });
    const denied = errorOf(await remote(contactContext(), "read", { id: WEEKLY }));
    expect(denied.code).toBe("MCP_AUDIENCE");
    expect(reads()).toEqual([]);
  });

  it("refuses a read of a skill not pinned to the turn's agent", async () => {
    await startDaemon();
    await remote(operatorContext("other"), "pin", { server: "docs", skill: WEEKLY, execute: true });
    const answer = errorOf(await remote(operatorContext(), "read", { id: WEEKLY }));
    expect(answer.code).toBe("MCP_SKILL_NOT_PINNED");
  });
});

describe("remote skill pins and the Library plugin", () => {
  async function pinned(audience: "operator" | "any" = "operator", external = false) {
    await startDaemon(audience);
    await pinWeekly(external ? { external: true } : {});
  }

  it("lets the existing Library gate decide each load: operator-only on a contact turn is denied", async () => {
    await pinned();
    const skill = `ravi-library:${STUB}`;
    expect(isLibraryPluginSkillAllowedForTurn({ agentId: "main", skill, isOperatorOwnTurn: () => true })).toBe(true);
    expect(isLibraryPluginSkillAllowedForTurn({ agentId: "main", skill, isOperatorOwnTurn: () => false })).toBe(false);
    expect(isLibraryPluginSkillAllowedForTurn({ agentId: "other", skill, isOperatorOwnTurn: () => true })).toBe(false);
    // A disabled server loads nothing, whatever the turn.
    updateMcpServerConfig("docs", { enabled: false });
    expect(isLibraryPluginSkillAllowedForTurn({ agentId: "main", skill, isOperatorOwnTurn: () => true })).toBe(false);
  });

  it("loads an external pin on a contact turn and adds the stub to the allowlist only", async () => {
    await pinned("any", true);
    const skill = `ravi-library-${STUB}`;
    expect(isLibraryPluginSkillAllowedForTurn({ agentId: "main", skill, isOperatorOwnTurn: () => false })).toBe(true);
    expect(readAgentLibraryPins("main")).toEqual({ libraryIds: [], skillNames: [STUB] });
    const session = resolveLibrarySessionPlugins({
      agentId: "main",
      sharedSkillsDir: false,
      isOperatorOwnTurn: () => false,
    });
    expect(session).toMatchObject({ variant: "all", skills: [STUB] });
    expect(session.plugins).toHaveLength(1);
    const codex = resolveLibrarySessionPlugins({
      agentId: "other",
      sharedSkillsDir: true,
      isOperatorOwnTurn: () => true,
    });
    expect(codex.hiddenSkills).toEqual([`ravi-library-${STUB}`]);
    expect(
      existsSync(join(libraryUnionPluginDir(dbGetLibraryPinState()!.pluginDir!), "skills", STUB, "SKILL.md")),
    ).toBe(true);
  });

  it("survives a Console Library sync, which keeps the stub next to the Library skills", async () => {
    await pinned();
    const fake = createFakeConsole([fakeSkill({ slug: "tom-de-voz", version: 3, externalAllowed: true })]);
    fake.pins.push({
      id: "pin-1",
      installationId: "inst-1",
      agentId: "main",
      scope: "org",
      project: null,
      slug: "tom-de-voz",
      pinnedBy: "Op",
    });
    await syncLibraryPins(fakeSession(fake), { report: false }, { emitConfigChanged: () => {} });
    expect(listMcpSkillPins()).toHaveLength(1);
    expect(generationSkills("main", "all")).toEqual([STUB, "org-tom-de-voz"].sort());

    // The Console drops every Library pin: the remote pin and its stub stay.
    fake.pins.length = 0;
    await syncLibraryPins(fakeSession(fake), { report: false }, { emitConfigChanged: () => {} });
    expect(listMcpSkillPins()).toHaveLength(1);
    expect(generationSkills("main", "all")).toEqual([STUB]);

    // An unpin rebuilds without the stub and keeps the Library pins.
    fake.pins.push({
      ...{
        id: "pin-2",
        installationId: "inst-1",
        agentId: "main",
        scope: "org",
        project: null,
        slug: "tom-de-voz",
        pinnedBy: "Op",
      },
    });
    await syncLibraryPins(fakeSession(fake), { report: false }, { emitConfigChanged: () => {} });
    const unpinned = await remote(operatorContext(), "unpin", { id: WEEKLY });
    expect(unpinned.body).toMatchObject({ removed: true, pluginRebuilt: true });
    expect(generationSkills("main", "all")).toEqual(["org-tom-de-voz"]);
  });

  it("leaves out a stub whose plugin name a Library pin already uses", async () => {
    await pinned();
    upsertMcpSkillPin({
      ...getMcpSkillPin("main", "docs", fixtureSkillUri("weekly-report"))!,
      skillName: "org-tom-de-voz",
    });
    const fake = createFakeConsole([fakeSkill({ slug: "tom-de-voz", version: 3 })]);
    fake.pins.push({
      id: "pin-1",
      installationId: "inst-1",
      agentId: "main",
      scope: "org",
      project: null,
      slug: "tom-de-voz",
      pinnedBy: "Op",
    });
    await syncLibraryPins(fakeSession(fake), { report: false }, { emitConfigChanged: () => {} });
    const stub = join(
      libraryAgentPluginDir(dbGetLibraryPinState()!.pluginDir!, "main", "all"),
      "skills",
      "org-tom-de-voz",
      "SKILL.md",
    );
    expect(readFileSync(stub, "utf8")).not.toContain("ravi mcp skills read");
  });

  it("drops the pins of a detached agent and of a removed server, and rebuilds the plugin", async () => {
    await pinned();
    await remote(operatorContext("other"), "pin", { server: "docs", skill: WEEKLY, execute: true });
    const commands = new McpCommands();
    const detached = (await commands.detach("docs", "other", true)) as { skillPinsDropped: number };
    expect(detached.skillPinsDropped).toBe(1);
    expect(listMcpSkillPins().map((pin) => pin.agentId)).toEqual(["main"]);
    const removed = (await commands.remove("docs", true)) as { skillPinsDropped: number };
    expect(removed.skillPinsDropped).toBe(1);
    expect(listMcpSkillPins()).toEqual([]);
    expect(generationSkills("main", "all")).toEqual([]);
  });

  it("unpins at once from the agent's own turn, and refuses another agent's pin from a contact turn", async () => {
    await pinned("any");
    const refused = errorOf(await remote(contactContext(MUTATE_CAPS), "unpin", { id: WEEKLY, agent: "other" }));
    expect(refused.code).toBe("OPERATOR_TURN_REQUIRED");
    const done = await remote(contactContext(MUTATE_CAPS), "unpin", { id: WEEKLY });
    expect(done.body).toMatchObject({ removed: true, agent: "main" });
    expect(listMcpSkillPins()).toEqual([]);
  });
});

describe("remote skill pins reconciled with the server's listing", () => {
  const WITHOUT_WEEKLY = { "pdf-forms/SKILL.md": FIXTURE_SKILL_FILES["pdf-forms/SKILL.md"]! };
  const CHANGED = {
    ...FIXTURE_SKILL_FILES,
    "weekly-report/SKILL.md": "---\nname: weekly-report\ndescription: Write the weekly report.\n---\n# Changed\n",
  };

  function pinStates(): Array<[string, string, string | null]> {
    return listMcpSkillPins().map((pin) => [pin.agentId, pin.state, pin.staleReason]);
  }

  async function pinBoth(): Promise<void> {
    await pinWeekly();
    await remote(operatorContext("other"), "pin", { server: "docs", skill: WEEKLY, execute: true });
  }

  function skillsLists(): number {
    return fixture!.methods.filter((method) => method === "skills/list").length;
  }

  it("marks an unpublished skill's pins gone, shows them apart, and restores them when it is listed again on the approved digest", async () => {
    await startDaemon();
    await pinBoth();
    await fixture!.setFiles(WITHOUT_WEEKLY);
    const gone = await remote(operatorContext(), "list", { server: "docs" });
    expect(gone.body).toMatchObject({ total: 1, pinCheck: "done", restoredPins: [] });
    expect(gone.body.stalePins).toEqual([
      { agent: "main", id: WEEKLY, reason: "gone" },
      { agent: "other", id: WEEKLY, reason: "gone" },
    ]);
    expect(pinStates()).toEqual([
      ["main", "stale", "gone"],
      ["other", "stale", "gone"],
    ]);
    // Its stub leaves the plugin before any model reads it.
    expect(generationSkills("main", "all")).toEqual([]);
    // The pins are shown apart, and ravi mcp show lists every pin with its state and reason.
    expect(gone.body.unlistedPins).toEqual([
      { id: WEEKLY, agent: "main", skill: STUB, state: "stale", staleReason: "gone", externalAllowed: false },
      { id: WEEKLY, agent: "other", skill: STUB, state: "stale", staleReason: "gone", externalAllowed: false },
    ]);
    const shown = (await new McpCommands().show("docs", true)) as { skills: Array<Record<string, unknown>> };
    expect(shown.skills).toEqual([
      {
        agentId: "main",
        skillId: WEEKLY,
        skillName: STUB,
        state: "stale",
        staleReason: "gone",
        externalAllowed: false,
      },
      {
        agentId: "other",
        skillId: WEEKLY,
        skillName: STUB,
        state: "stale",
        staleReason: "gone",
        externalAllowed: false,
      },
    ]);

    // Published again with the approved bytes: the same digest restores both pins, with no new pin.
    await fixture!.setFiles(FIXTURE_SKILL_FILES);
    const back = await remote(operatorContext(), "list", { server: "docs" });
    expect(back.body.restoredPins).toEqual([
      { agent: "main", id: WEEKLY },
      { agent: "other", id: WEEKLY },
    ]);
    expect(back.body.unlistedPins).toEqual([]);
    expect(pinStates()).toEqual([
      ["main", "active", null],
      ["other", "active", null],
    ]);
    expect(generationSkills("main", "all")).toEqual([STUB]);
  });

  it("survives the organization's skills switch going off and on: no pin is lost and none needs a new pin", async () => {
    await startDaemon();
    await pinBoth();
    const traced: McpSkillTraceInput[] = [];
    setMcpTraceSinksForTests({ skill: (event) => traced.push(event) });
    // Switched off: the listing is empty and get answers as for an unpublished skill.
    await fixture!.setFiles({});
    const empty = await remote(operatorContext(), "list", { server: "docs" });
    expect(empty.body).toMatchObject({ total: 0, pinCheck: "empty_listing", stalePins: [] });
    expect(pinStates()).toEqual([
      ["main", "active", null],
      ["other", "active", null],
    ]);
    // A read while it is off finds the skill gone: the pins stop loading, and the refusal says why.
    const read = errorOf(await remote(operatorContext(), "read", { id: WEEKLY }));
    expect(read.code).toBe("MCP_SKILL_STALE");
    expect(read.message).toContain("gone");
    expect(read.message).not.toContain("changed on its server");
    expect(pinStates()).toEqual([
      ["main", "stale", "gone"],
      ["other", "stale", "gone"],
    ]);

    // Switched on again: the daemon's refresh lists the skill on the approved digest and restores every pin.
    await fixture!.setFiles(FIXTURE_SKILL_FILES);
    await getMcpGateway()!.refreshSkillPins();
    expect(pinStates()).toEqual([
      ["main", "active", null],
      ["other", "active", null],
    ]);
    const again = await remote(operatorContext(), "read", { id: WEEKLY });
    expect(again.body.text).toBe(FIXTURE_SKILL_FILES["weekly-report/SKILL.md"]);
    // Each automatic change is traced with its reason.
    const changes = traced.filter((event) => event.op === "pin_state");
    expect(changes.map((event) => [event.pinAgent, event.outcome, event.reason])).toEqual([
      ["main", "stale", "gone"],
      ["other", "stale", "gone"],
      ["main", "restored", "listed_on_approved_digest"],
      ["other", "restored", "listed_on_approved_digest"],
    ]);
  });

  it("stops the refresh tick's walk with the gateway: no listing is in flight or started once stop() returns", async () => {
    await startDaemon();
    await pinWeekly();
    // A second server with a pin: the walk lists docs, then docs2.
    createMcpServer({ name: "docs2", transport: "http", url: fixture!.url, authKind: "none", protocol: "2026-07-28" });
    await writeMcpServerSecret("docs2", { url: fixture!.url });
    attachMcpServer({ agentId: "main", server: "docs2", audience: "operator" });
    expect((await getMcpGateway()!.refresh("docs2"))?.status).toBe("ok");
    await remote(operatorContext(), "pin", {
      server: "docs2",
      skill: "mcp:docs2:project/prs/weekly-report",
      execute: true,
    });
    const states = pinStates();
    fixture!.hang(["skills/list"]);
    const gateway = getMcpGateway()!;
    let walkDone = false;
    void gateway.refreshSkillPins().then(() => {
      walkDone = true;
    });
    const waitFor = async (check: () => boolean, what: string) => {
      const deadline = Date.now() + 5_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(what);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitFor(() => fixture!.hanging.held === 1, "the walk never listed");
    const started = Date.now();
    await stopMcpGateway();
    // The walk ended inside stop(), well before the listing's own 30 s timeout.
    expect(Date.now() - started).toBeLessThan(MCP_GATEWAY_STOP_WAIT_MS);
    expect(walkDone).toBe(true);
    // The listing was abandoned by the client, and the stopped walk never went on to the next server.
    await waitFor(() => fixture!.hanging.abandoned === 1, "the listing was never aborted");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fixture!.hanging).toEqual({ held: 1, abandoned: 1 });
    // A stop learns nothing about the servers: the pins and the rows are as they were.
    expect(pinStates()).toEqual(states);
    expect(getMcpServer("docs")?.status).toBe("ok");
    expect(getMcpServer("docs2")?.status).toBe("ok");
  });

  it("never restores a changed manifest: a pin stale as manifest_changed stays stale when the approved bytes come back", async () => {
    await startDaemon();
    await pinWeekly();
    await fixture!.setFiles(CHANGED);
    const changed = await remote(operatorContext(), "list", { server: "docs" });
    expect(changed.body.stalePins).toEqual([{ agent: "main", id: WEEKLY, reason: "manifest_changed" }]);
    await fixture!.setFiles(FIXTURE_SKILL_FILES);
    const restored = await remote(operatorContext(), "list", { server: "docs" });
    expect(restored.body.restoredPins).toEqual([]);
    expect(pinStates()).toEqual([["main", "stale", "manifest_changed"]]);

    // A gone pin listed again on another manifest is manifest_changed too, and stays so on the approved bytes.
    await pinWeekly();
    await fixture!.setFiles(WITHOUT_WEEKLY);
    await remote(operatorContext(), "list", { server: "docs" });
    expect(pinStates()).toEqual([["main", "stale", "gone"]]);
    await fixture!.setFiles(CHANGED);
    const retagged = await remote(operatorContext(), "list", { server: "docs" });
    expect(retagged.body.stalePins).toEqual([{ agent: "main", id: WEEKLY, reason: "manifest_changed" }]);
    await fixture!.setFiles(FIXTURE_SKILL_FILES);
    await getMcpGateway()!.refreshSkillPins();
    expect(pinStates()).toEqual([["main", "stale", "manifest_changed"]]);
    expect(generationSkills("main", "all")).toEqual([]);
  });

  it("walks every page before deciding: an empty first page with a cursor marks nothing", async () => {
    await startDaemon();
    await pinWeekly();
    fixture!.emptyFirstPage(true);
    const listed = await remote(operatorContext(), "list", { server: "docs" });
    expect(listed.body).toMatchObject({ total: 2, pinCheck: "done", stalePins: [] });
    expect(skillsLists()).toBe(2);
    await getMcpGateway()!.refreshSkillPins();
    expect(pinStates()).toEqual([["main", "active", null]]);
  });

  it("refreshes once per server per run, never during its back-off, and never without the skills scope", async () => {
    await startDaemon();
    await pinBoth();
    await fixture!.setFiles(WITHOUT_WEEKLY);
    const before = skillsLists();
    // A back-off holds: nothing is sent and nothing changes.
    recordMcpServerRateLimit("docs", "skills/list", Date.now() + 60_000);
    await getMcpGateway()!.refreshSkillPins();
    expect(skillsLists()).toBe(before);
    expect(pinStates()).toEqual([
      ["main", "active", null],
      ["other", "active", null],
    ]);
    getDb().prepare("DELETE FROM mcp_server_rate_limits WHERE server = ?").run("docs");

    // A grant without the advertised skills scope: not walked.
    await writeMcpServerSecret("docs", { url: fixture!.url, oauth: oauthWithScopes("mcp.console.tools.read") });
    await getMcpGateway()!.refreshSkillPins();
    expect(skillsLists()).toBe(before);

    // With it: one walk for both agents' pins.
    await writeMcpServerSecret("docs", { url: fixture!.url, oauth: oauthWithScopes("mcp.console.skills.read") });
    await getMcpGateway()!.refreshSkillPins();
    expect(skillsLists()).toBe(before + 1);
    expect(pinStates()).toEqual([
      ["main", "stale", "gone"],
      ["other", "stale", "gone"],
    ]);
  });
});

function oauthWithScopes(scope: string | null): NonNullable<McpServerSecret["oauth"]> {
  return {
    tokens: { access_token: "tok_docs", token_type: "bearer", ...(scope !== null ? { scope } : {}) },
    discovery: {
      authorizationServerUrl: "https://auth.example.test",
      authorizationServerMetadata: {
        issuer: "https://auth.example.test",
        scopes_supported: ["mcp.console.tools.read", "mcp.console.tools.write", "mcp.console.skills.read"],
      },
    },
  };
}

describe("ravi mcp skills: paging, scope, audience, ids, cache and trace", () => {
  async function terminal(fn: (commands: McpSkillsCommands) => unknown) {
    const out: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...items: unknown[]) => void out.push(items.map(String).join(" "));
    console.error = (...items: unknown[]) => void out.push(items.map(String).join(" "));
    try {
      return { result: (await fn(new McpSkillsCommands())) as Record<string, unknown>, out };
    } catch (error) {
      return { error, out };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  it("pages the listing with --limit and --offset, with total and the next command, also from a terminal", async () => {
    await startDaemon();
    const first = await remote(operatorContext(), "list", { server: "docs", limit: "1", offset: "0" });
    expect(first.body).toMatchObject({ total: 2 });
    expect((first.body.skills as Array<{ id: string }>).map((skill) => skill.id)).toEqual([
      "mcp:docs:project/prs/pdf-forms",
    ]);
    expect(first.body.pagination).toMatchObject({
      limit: 1,
      offset: 0,
      returned: 1,
      total: 2,
      hasMore: true,
      nextOffset: 1,
      nextCommand: "ravi mcp skills list docs --limit 1 --offset 1",
    });
    const bad = errorOf(await remote(operatorContext(), "list", { server: "docs", limit: "0" }));
    expect(bad.exitCode).toBe(2);

    // From a terminal, the paging goes through the forwarding to the daemon.
    await socket?.stop();
    socket = await startHostCliGateway({ gateway: { registry: buildRegistry([McpCommands, McpSkillsCommands]) } });
    process.env.RAVI_CONTEXT_KEY = operatorContext().contextKey;
    const forwarded = await terminal((commands) => commands.list("docs", undefined, "1", "1", true));
    expect(forwarded.error).toBeUndefined();
    expect((forwarded.result!.skills as Array<{ id: string }>).map((skill) => skill.id)).toEqual([WEEKLY]);
    expect(forwarded.result!.pagination).toMatchObject({ offset: 1, returned: 1, total: 2, hasMore: false });
  });

  it("says when the stored login lacks the skills scope the server advertises, without failing the listing", async () => {
    await startDaemon();
    await pinWeekly();
    await writeMcpServerSecret("docs", { url: fixture!.url, oauth: oauthWithScopes("mcp.console.tools.read") });
    await fixture!.setFiles({});
    const listed = await remote(operatorContext(), "list", { server: "docs" });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ total: 0, scopeMissing: true, pinCheck: "scope_missing" });
    expect(listed.body.suggestedAction).toContain("mcp.console.skills.read");
    expect(listed.body.suggestedAction).toContain("ravi mcp login docs --execute");
    expect(getMcpSkillPin("main", "docs", fixtureSkillUri("weekly-report"))?.state).toBe("active");

    await writeMcpServerSecret("docs", { url: fixture!.url, oauth: oauthWithScopes("mcp.console.skills.read") });
    const granted = await remote(operatorContext(), "list", { server: "docs" });
    expect(granted.body).toMatchObject({ scopeMissing: false, suggestedAction: null, pinCheck: "empty_listing" });
  });

  it("reads the skills scope only from a grant that names its scopes and a server that advertises one", async () => {
    const status = (secret: McpServerSecret | null) => mcpSkillsScopeStatus("docs", { readSecret: async () => secret });
    expect(await status(null)).toEqual({ missing: false, scope: null });
    expect(await status({ bearer: "t" })).toEqual({ missing: false, scope: null });
    expect(await status({ oauth: oauthWithScopes(null) })).toEqual({
      missing: false,
      scope: "mcp.console.skills.read",
    });
    expect(await status({ oauth: oauthWithScopes("mcp.console.tools.read mcp.console.tools.write") })).toEqual({
      missing: true,
      scope: "mcp.console.skills.read",
    });
    expect(await status({ oauth: oauthWithScopes("mcp.console.skills.read") })).toEqual({
      missing: false,
      scope: "mcp.console.skills.read",
    });
    const noSkills = oauthWithScopes("read");
    (noSkills.discovery!.authorizationServerMetadata as Record<string, unknown>).scopes_supported = ["read"];
    expect(await status({ oauth: noSkills })).toEqual({ missing: false, scope: null });
  });

  it("refuses the listing on any turn but the operator's own, before anything is sent", async () => {
    await startDaemon("any");
    const before = fixture!.methods.length;
    const refused = errorOf(await remote(contactContext(), "list", { server: "docs" }));
    expect(refused).toMatchObject({ code: "OPERATOR_TURN_REQUIRED", exitCode: 3 });
    expect(fixture!.methods.length).toBe(before);
  });

  it("warns when --external meets an operator-audience attachment, in the plan and the result", async () => {
    await startDaemon("operator");
    const dry = errorOf(await remote(operatorContext(), "pin", { server: "docs", skill: WEEKLY, external: true }));
    const warnings = dry.plan!.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("audience operator");
    expect(warnings[0]).toContain("MCP_AUDIENCE");
    expect(warnings[0]).toContain("ravi mcp set docs --audience any --agent main --execute");
    const pinned = await pinWeekly({ external: true });
    expect(pinned.body.warnings).toEqual(warnings);
    const plain = await pinWeekly();
    expect(plain.body.warnings).toEqual([]);
  });

  it("normalizes a trailing /SKILL.md the same way for pin and read", async () => {
    expect(parseMcpSkillId(`${WEEKLY}/SKILL.md`).id).toBe(WEEKLY);
    expect(mcpSkillUriFromArg("docs", `${WEEKLY}/SKILL.md`)).toBe(fixtureSkillUri("weekly-report"));
    expect(mcpSkillUriFromArg("docs", "project/prs/weekly-report/SKILL.md")).toBe(fixtureSkillUri("weekly-report"));
    await startDaemon();
    await pinWeekly();
    const read = await remote(operatorContext(), "read", { id: `${WEEKLY}/SKILL.md` });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: WEEKLY, file: "SKILL.md" });
  });

  it("keeps the media type with the cached bytes and traces every read and refusal without content", async () => {
    await startDaemon("any");
    await pinWeekly();
    const traced: McpSkillTraceInput[] = [];
    setMcpTraceSinksForTests({ skill: (event) => traced.push(event) });
    const fetched = await remote(operatorContext(), "read", { id: WEEKLY, file: "references/GUIDE.md" });
    const cached = await remote(operatorContext(), "read", { id: WEEKLY, file: "references/GUIDE.md" });
    expect(fetched.body.cached).toBe(false);
    expect(cached.body.cached).toBe(true);
    expect(fetched.body.mimeType).toBeString();
    expect(cached.body.mimeType).toBe(fetched.body.mimeType);

    errorOf(await remote(contactContext(), "read", { id: WEEKLY }));
    const strip = ({ context: _context, durationMs: _duration, ...rest }: McpSkillTraceInput) => rest;
    expect(traced.map(strip)).toEqual([
      {
        agentId: "main",
        server: "docs",
        op: "read",
        skill: WEEKLY,
        file: "references/GUIDE.md",
        bytes: 29,
        source: "fetched",
        outcome: "ok",
      },
      {
        agentId: "main",
        server: "docs",
        op: "read",
        skill: WEEKLY,
        file: "references/GUIDE.md",
        bytes: 29,
        source: "cached",
        outcome: "ok",
      },
      {
        agentId: "main",
        server: "docs",
        op: "read",
        skill: WEEKLY,
        file: "SKILL.md",
        bytes: 0,
        outcome: "denied",
        reason: "MCP_SKILL_EXTERNAL_DENIED",
      },
    ]);
    expect(JSON.stringify(traced)).not.toContain("short sentences");
  });

  it("traces an audience denial and a stale pin", async () => {
    await startDaemon("operator");
    await pinWeekly({ external: true });
    const traced: McpSkillTraceInput[] = [];
    setMcpTraceSinksForTests({ skill: (event) => traced.push(event) });
    errorOf(await remote(contactContext(), "read", { id: WEEKLY }));
    await fixture!.setFiles({
      ...FIXTURE_SKILL_FILES,
      "weekly-report/SKILL.md": "---\nname: weekly-report\ndescription: Write the weekly report.\n---\n# Changed\n",
    });
    errorOf(await remote(operatorContext(), "read", { id: WEEKLY }));
    const reads = traced.filter((event) => event.op === "read");
    expect(reads.map((event) => [event.outcome, event.reason])).toEqual([
      ["denied", "MCP_AUDIENCE"],
      ["error", "MCP_SKILL_STALE:manifest_changed"],
    ]);
    expect(traced.filter((event) => event.op === "pin_state").map((event) => event.reason)).toEqual([
      "manifest_changed",
    ]);
  });
});

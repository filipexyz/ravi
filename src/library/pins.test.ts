import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CloudAuthError } from "../cloud-auth/errors.js";
import { upsertConsoleScopeDefault } from "../console-scope/store.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { dbUpsertSkillGrant } from "../router/index.js";
import { resolveAgentSkills } from "../runtime/allowed-skills.js";
import { isLibrarySkillAuthorizedForAgent, isSkillAuthorizedForAgent } from "../runtime/skill-authorization.js";
import { extractSkillNameFromFilesystemPath } from "../runtime/skill-visibility.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbSetLibraryAgentAcceptsRequests, dbSetLibraryAgentListed } from "./agents-db.js";
import { parseLibraryRef } from "./refs.js";
import { LibraryPinRunner, libraryPinIntervalMs } from "./pin-runner.js";
import { dbGetLibraryPinState, dbListLibraryPins } from "./pins-db.js";
import {
  collectLocalAgentReports,
  executeLibraryPin,
  executeLibraryUnpin,
  listLocalLibraryPins,
  prepareLibraryPin,
  syncLibraryPins,
  type LibraryPinDeps,
} from "./pins.js";
import {
  assignLibrarySkillNames,
  libraryAgentPluginDir,
  libraryUnionPluginDir,
  withSkillName,
  isInsideLibraryPluginsRoot,
} from "./plugin.js";
import { resolveLibrarySessionPlugins } from "./session-plugins.js";
import { createFakeConsole, fakeCredentials, fakeSession, fakeSkill, type FakeConsole } from "./test-fixtures.js";

let stateDir: string | null = null;
let fake: FakeConsole;
let emitted: number;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-pins-");
  fake = createFakeConsole([
    fakeSkill({ slug: "tom-de-voz", version: 3, externalAllowed: true }),
    fakeSkill({ slug: "interna", version: 1 }),
    fakeSkill({ slug: "triagem", project: "clinica", version: 2 }),
  ]);
  emitted = 0;
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function deps(extra: Partial<LibraryPinDeps> = {}): LibraryPinDeps {
  return {
    collectAgents: async () => [
      { id: "main", name: "Main", provider: "claude", model: null, project: null },
      { id: "atendente", name: "Atendente", provider: "codex", model: null, project: "clinica" },
    ],
    emitConfigChanged: () => {
      emitted += 1;
    },
    ...extra,
  };
}

function pin(agentId: string, slug: string, project: string | null = null) {
  fake.pins.push({
    id: `pin-${fake.pins.length + 1}`,
    installationId: "inst-1",
    agentId,
    scope: project ? "project" : "org",
    project,
    slug,
    pinnedBy: "Op",
  });
}

function libraryRequests(): string[] {
  return fake.requests
    .filter((request) => request.path.startsWith("/api/cli/library/"))
    .map((request) => `${request.method} ${request.path}`);
}

describe("library pin client", () => {
  it("reports agents and reads pins on the documented paths", async () => {
    pin("main", "tom-de-voz");
    const session = fakeSession(fake);
    const synced = await session.client.syncPins([{ id: "main", name: "Main", project: null }]);
    expect(synced.installation).toEqual({ id: "inst-1", name: "macbook" });
    expect(synced.pins).toMatchObject([{ agentId: "main", ref: "org/tom-de-voz", item: { slug: "tom-de-voz" } }]);
    expect(fake.requests[0]?.body).toEqual({ agents: [{ id: "main", name: "Main", project: null }] });

    await session.client.listInstallationPins();
    const ref = parseLibraryRef("org/tom-de-voz")!;
    await session.client.listItemPins(ref);
    await session.client.pin(ref, { agentId: "main" });
    expect(await session.client.unpin(ref, { agentId: "main" })).toEqual({ removed: true });
    expect(await session.client.unpin(ref, { agentId: "main" })).toEqual({ removed: false });
    expect(libraryRequests()).toEqual([
      "POST /api/cli/library/pins/sync",
      "GET /api/cli/library/pins",
      "GET /api/cli/library/skills/org/tom-de-voz/pins",
      "POST /api/cli/library/skills/org/tom-de-voz/pin",
      "POST /api/cli/library/skills/org/tom-de-voz/unpin",
      "POST /api/cli/library/skills/org/tom-de-voz/unpin",
    ]);
    expect(fake.requests.at(-1)?.body).toEqual({ agentId: "main" });
  });

  it("keeps the Console's conflict reason", async () => {
    fake.installation = null;
    const error = await fakeSession(fake)
      .client.listInstallationPins()
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudAuthError);
    expect((error as CloudAuthError).code).toBe("CONFLICT");
    expect((error as CloudAuthError).details?.reason).toBe("no_installation");
  });
});

describe("library pin sync", () => {
  it("caches each pinned version, stores the pins and generates the plugin", async () => {
    pin("main", "tom-de-voz");
    pin("main", "interna");
    pin("atendente", "triagem", "clinica");
    const outcome = await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(outcome.changed).toBe(true);
    expect(outcome.reported).toBe(2);
    expect(emitted).toBe(1);
    expect(fake.reportedAgents.get("inst-1")?.map((agent) => agent.id)).toEqual(["main", "atendente"]);

    const rows = dbListLibraryPins();
    expect(rows.map((row) => [row.agentId, row.ref, row.skillName, row.version, row.externalAllowed])).toEqual([
      ["atendente", "clinica/triagem", "clinica-triagem", 2, false],
      ["main", "org/interna", "org-interna", 1, false],
      ["main", "org/tom-de-voz", "org-tom-de-voz", 3, true],
    ]);
    const state = dbGetLibraryPinState()!;
    expect(state.installationId).toBe("inst-1");
    expect(state.pluginDir).not.toBeNull();

    const union = libraryUnionPluginDir(state.pluginDir!);
    expect(readdirSync(join(union, "skills")).sort()).toEqual(["clinica-triagem", "org-interna", "org-tom-de-voz"]);
    expect(JSON.parse(readFileSync(join(union, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("ravi-library");
    const mainAll = libraryAgentPluginDir(state.pluginDir!, "main", "all");
    expect(readdirSync(join(mainAll, "skills")).sort()).toEqual(["org-interna", "org-tom-de-voz"]);
    expect(readFileSync(join(mainAll, "skills", "org-tom-de-voz", "SKILL.md"), "utf8")).toContain(
      "name: org-tom-de-voz",
    );
    expect(existsSync(join(mainAll, "skills", "org-tom-de-voz", "references", "guia.md"))).toBe(true);
    expect(existsSync(join(mainAll, "skills", "org-tom-de-voz", "item.json"))).toBe(false);
    const mainExternal = libraryAgentPluginDir(state.pluginDir!, "main", "external");
    expect(readdirSync(join(mainExternal, "skills"))).toEqual(["org-tom-de-voz"]);
    // No externalAllowed skill pinned: no external variant at all.
    expect(existsSync(libraryAgentPluginDir(state.pluginDir!, "atendente", "external"))).toBe(false);
  });

  it("does nothing new when the pins did not change, and re-applies a new version", async () => {
    pin("main", "tom-de-voz");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    const first = dbGetLibraryPinState()!.pluginDir;
    const again = await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(again.changed).toBe(false);
    expect(emitted).toBe(1);

    fake.skills = fake.skills.map((skill) =>
      skill.item.slug === "tom-de-voz" ? { ...skill, item: { ...skill.item, version: 4, contentHash: "next" } } : skill,
    );
    const updated = await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(updated.changed).toBe(true);
    expect(emitted).toBe(2);
    expect(dbListLibraryPins()[0]?.version).toBe(4);
    expect(dbGetLibraryPinState()!.pluginDir).not.toBe(first);
  });

  it("reads without reporting when the login lacks the link scope", async () => {
    pin("main", "tom-de-voz");
    const session = { ...fakeSession(fake), scopes: ["console.projects.read"] };
    const outcome = await syncLibraryPins(session, { report: true }, deps());
    expect(outcome.reported).toBeNull();
    expect(libraryRequests()[0]).toBe("GET /api/cli/library/pins");
    expect(dbListLibraryPins()).toHaveLength(1);
  });

  it("keeps the last pins when the Console cannot be reached", async () => {
    pin("main", "tom-de-voz");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    fake.offline = true;
    await expect(syncLibraryPins(fakeSession(fake), { report: true }, deps())).rejects.toBeInstanceOf(CloudAuthError);
    expect(dbListLibraryPins()).toHaveLength(1);
    expect(dbGetLibraryPinState()?.lastErrorCode).toBeTruthy();
  });

  it("leaves out a pinned item this login cannot read and loads the rest", async () => {
    pin("main", "tom-de-voz");
    pin("main", "interna");
    fake.unreadable.add("org/interna");
    const outcome = await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(outcome.unavailable).toEqual([{ agentId: "main", ref: "org/interna", code: "LIBRARY_PIN_UNAVAILABLE" }]);
    expect(dbListLibraryPins().map((row) => row.ref)).toEqual(["org/tom-de-voz"]);
    // The next sync tries the missing one again, without a new notice when nothing changed.
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(emitted).toBe(1);
    const partialDir = dbGetLibraryPinState()?.pluginDir;
    fake.unreadable.clear();
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(dbListLibraryPins()).toHaveLength(2);
    // The full apply writes its own generation; it never reuses the partial one.
    const fullDir = dbGetLibraryPinState()?.pluginDir;
    expect(fullDir).toBeTruthy();
    expect(fullDir).not.toBe(partialDir);
    const own = libraryAgentPluginDir(fullDir!, "main", "all");
    expect(existsSync(join(own, "skills", "org-interna", "SKILL.md"))).toBe(true);
    expect(existsSync(join(own, "skills", "org-tom-de-voz", "SKILL.md"))).toBe(true);
  });

  it("empties the pins when the Console answers none", async () => {
    pin("main", "tom-de-voz");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    fake.pins = [];
    const outcome = await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(outcome.changed).toBe(true);
    expect(dbListLibraryPins()).toEqual([]);
    expect(dbGetLibraryPinState()?.pluginDir).toBeNull();
  });
});

describe("library plugin names", () => {
  it("names skills by scope and slug, hashing collisions and long names", () => {
    const names = assignLibrarySkillNames([
      { libraryId: "org:x-y", baseName: "org-x-y" },
      { libraryId: "project:org-x:y", baseName: "org-x-y" },
      { libraryId: "project:p:long", baseName: `p-${"a".repeat(70)}` },
    ]);
    expect(names.get("org:x-y")).toBe("org-x-y");
    expect(names.get("project:org-x:y")).toMatch(/^org-x-y-[0-9a-f]{8}$/);
    expect(names.get("project:p:long")!.length).toBeLessThanOrEqual(64);
  });

  it("rewrites the frontmatter name only", () => {
    expect(withSkillName("---\nname: x\ndescription: d\n---\n\nbody", "org-x")).toBe(
      "---\nname: org-x\ndescription: d\n---\n\nbody",
    );
    expect(withSkillName("no frontmatter", "org-x")).toBe("---\nname: org-x\n---\n\nno frontmatter");
  });
});

describe("library session plugins", () => {
  async function synced() {
    pin("main", "tom-de-voz");
    pin("main", "interna");
    pin("atendente", "triagem", "clinica");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    return dbGetLibraryPinState()!.pluginDir!;
  }

  it("gives an agent its own plugin: everything in the operator's own turns", async () => {
    const dir = await synced();
    const own = resolveLibrarySessionPlugins({
      agentId: "main",
      sharedSkillsDir: false,
      isOperatorOwnTurn: () => true,
    });
    expect(own.plugins).toEqual([{ type: "local", path: libraryAgentPluginDir(dir, "main", "all") }]);
    expect(own.skills.sort()).toEqual(["org-interna", "org-tom-de-voz"]);
    expect(own.hiddenSkills).toEqual([]);
  });

  it("gives only externalAllowed skills in other turns, and nothing to agents without pins", async () => {
    const dir = await synced();
    const external = resolveLibrarySessionPlugins({
      agentId: "main",
      sharedSkillsDir: false,
      isOperatorOwnTurn: () => false,
    });
    expect(external.plugins).toEqual([{ type: "local", path: libraryAgentPluginDir(dir, "main", "external") }]);
    expect(external.skills).toEqual(["org-tom-de-voz"]);

    const throwing = resolveLibrarySessionPlugins({
      agentId: "atendente",
      sharedSkillsDir: false,
      isOperatorOwnTurn: () => {
        throw new Error("unclassified");
      },
    });
    expect(throwing.plugins).toEqual([]);

    expect(
      resolveLibrarySessionPlugins({ agentId: "outro", sharedSkillsDir: false, isOperatorOwnTurn: () => true }).plugins,
    ).toEqual([]);
  });

  it("gives Codex the installation's plugin and hides what is not this session's", async () => {
    const dir = await synced();
    const codex = resolveLibrarySessionPlugins({
      agentId: "atendente",
      sharedSkillsDir: true,
      isOperatorOwnTurn: () => true,
    });
    expect(codex.plugins).toEqual([{ type: "local", path: libraryUnionPluginDir(dir) }]);
    expect(codex.hiddenSkills.sort()).toEqual(["ravi-library-org-interna", "ravi-library-org-tom-de-voz"]);

    const other = resolveLibrarySessionPlugins({
      agentId: "outro",
      sharedSkillsDir: true,
      isOperatorOwnTurn: () => true,
    });
    expect(other.hiddenSkills).toHaveLength(3);

    const external = resolveLibrarySessionPlugins({
      agentId: "main",
      sharedSkillsDir: true,
      isOperatorOwnTurn: () => false,
    });
    expect(external.hiddenSkills.sort()).toEqual(["ravi-library-clinica-triagem", "ravi-library-org-interna"]);
  });

  it("returns nothing before any sync", () => {
    expect(
      resolveLibrarySessionPlugins({ agentId: "main", sharedSkillsDir: true, isOperatorOwnTurn: () => true }),
    ).toMatchObject({ plugins: [], hiddenSkills: [] });
  });
});

describe("library pins authorize and join the allowlist", () => {
  it("authorizes the pinned item for its agent only, without configuring it", async () => {
    dbCreateAgent({ id: "outro", cwd: "/tmp/outro" });
    dbUpsertSkillGrant({ agentId: "main", skillName: "agents-manager" });
    dbUpsertSkillGrant({ agentId: "outro", skillName: "agents-manager" });
    pin("main", "interna");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());

    const main = resolveAgentSkills("main");
    expect(main.libraryPins).toEqual(["org:interna"]);
    expect(main.allowlist).toContain("ravi-library:org-interna");
    expect(main.allowlist).toContain("ravi-library-org-interna");
    expect(main.allowlist).not.toContain("org-interna");
    expect(isLibrarySkillAuthorizedForAgent("main", "org:interna")).toBe(true);
    expect(isSkillAuthorizedForAgent("main", "ravi-library:org-interna")).toBe(true);
    expect(isSkillAuthorizedForAgent("main", "org/interna")).toBe(true);

    expect(resolveAgentSkills("outro").allowlist).not.toContain("ravi-library:org-interna");
    expect(isLibrarySkillAuthorizedForAgent("outro", "org:interna")).toBe(false);
    expect(isSkillAuthorizedForAgent("outro", "ravi-library:org-interna")).toBe(false);

    // A pin alone never changes whether an agent is configured (narrowed).
    dbCreateAgent({ id: "livre", cwd: "/tmp/livre" });
    const before = resolveAgentSkills("livre").hasConfiguration;
    fake.pins = [];
    pin("livre", "interna");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    expect(resolveAgentSkills("livre").hasConfiguration).toBe(before);
  });

  it("reads a SKILL.md of the generated plugin as the plugin skill, never by its bare name", async () => {
    dbCreateAgent({ id: "outro", cwd: "/tmp/outro" });
    dbUpdateAgent("outro", {});
    dbUpsertSkillGrant({ agentId: "outro", skillName: "agents-manager" });
    pin("main", "interna");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    const file = join(libraryAgentPluginDir(dbGetLibraryPinState()!.pluginDir!, "main", "all"), "skills");
    const path = join(file, "org-interna", "SKILL.md");
    expect(isInsideLibraryPluginsRoot(path)).toBe(true);
    expect(extractSkillNameFromFilesystemPath(path)).toBe("ravi-library-org-interna");
    expect(isSkillAuthorizedForAgent("outro", extractSkillNameFromFilesystemPath(path)!)).toBe(false);
  });
});

describe("library pin commands (service)", () => {
  function commandDeps() {
    return { ...deps(), openSession: async () => fakeSession(fake) };
  }

  it("refuses to pin an unlisted agent before any request", async () => {
    const ref = parseLibraryRef("org/interna")!;
    await expect(prepareLibraryPin({ ref, agentId: "main" }, commandDeps())).rejects.toMatchObject({
      code: "LIBRARY_AGENT_NOT_LISTED",
      exitCode: 1,
    });
    expect(libraryRequests()).toEqual([]);
  });

  it("plans a pin without writing, then pins, reporting the agents first", async () => {
    const ref = parseLibraryRef("org/interna")!;
    dbSetLibraryAgentListed("main", true);
    const prepared = await prepareLibraryPin({ ref, agentId: "main" }, commandDeps());
    expect(prepared.plan).toMatchObject({
      ref: "org/interna",
      id: "org:interna",
      agent: "main",
      installationId: "inst-1",
      alreadyPinned: false,
      item: { version: 1, externalAllowed: false },
    });
    expect(libraryRequests()).toEqual(["GET /api/cli/library/skills/org/interna"]);

    const result = await executeLibraryPin(prepared, commandDeps());
    expect(result).toMatchObject({
      ref: "org/interna",
      agent: "main",
      created: true,
      pin: { agent: { id: "main", reported: true }, installation: { id: "inst-1" } },
      local: { pinned: true, refreshed: true, skill: "org-interna" },
    });
    expect(libraryRequests().slice(1)).toEqual([
      "POST /api/cli/library/pins/sync",
      "POST /api/cli/library/skills/org/interna/pin",
      "GET /api/cli/library/pins",
      "GET /api/cli/library/skills/org/interna?version=1",
    ]);
    expect(dbListLibraryPins().map((row) => row.ref)).toEqual(["org/interna"]);

    const again = await executeLibraryPin(
      await prepareLibraryPin({ ref, agentId: "main" }, commandDeps()),
      commandDeps(),
    );
    expect(again.created).toBe(false);
  });

  it("unpins and refreshes; offline after the unpin it drops the local pin anyway", async () => {
    const ref = parseLibraryRef("org/interna")!;
    pin("main", "interna");
    pin("main", "tom-de-voz");
    await syncLibraryPins(fakeSession(fake), { report: true }, deps());
    const result = await executeLibraryUnpin({ ref, agentId: "main" }, commandDeps());
    expect(result).toMatchObject({ removed: true, local: { pinned: false, refreshed: true } });

    const second = parseLibraryRef("org/tom-de-voz")!;
    const session = fakeSession(fake);
    const flaky = {
      ...commandDeps(),
      openSession: async () => ({
        ...session,
        client: Object.assign(Object.create(Object.getPrototypeOf(session.client)), session.client, {
          listInstallationPins: async () => {
            throw new CloudAuthError("HOST_UNREACHABLE", "offline");
          },
        }),
      }),
    };
    const offline = await executeLibraryUnpin({ ref: second, agentId: "main" }, flaky);
    expect(offline).toMatchObject({ removed: true, local: { pinned: false, refreshed: false } });
    expect(dbListLibraryPins()).toEqual([]);
  });

  it("lists the local pins, stale when the Console cannot be reached", async () => {
    pin("main", "interna");
    pin("main", "tom-de-voz");
    const fresh = await listLocalLibraryPins({}, commandDeps());
    expect(fresh).toMatchObject({ stale: false, total: 2, installation: { id: "inst-1", name: "macbook" } });
    fake.offline = true;
    const stale = await listLocalLibraryPins({ agentId: "main" }, commandDeps());
    expect(stale).toMatchObject({ stale: true, total: 2, agent: "main" });
    expect(stale.hint).toContain("last sync");

    const external = await listLocalLibraryPins(
      { inRuntime: true },
      { ...commandDeps(), turn: { operatorOwnTurn: false } },
    );
    expect(external.pins.map((entry) => entry.ref)).toEqual(["org/tom-de-voz"]);
  });
});

describe("library pin runner", () => {
  it("skips without a login", async () => {
    const runner = new LibraryPinRunner({ ...deps(), openSession: async () => null });
    expect(await runner.tickOnce()).toEqual({ status: "skipped", reason: "no_login" });
  });

  it("syncs, and keeps the pins on errors (quietly for an expired login)", async () => {
    pin("main", "interna");
    const runner = new LibraryPinRunner({ ...deps(), openSession: async () => fakeSession(fake) });
    expect((await runner.tickOnce()).status).toBe("synced");
    expect(dbListLibraryPins()).toHaveLength(1);

    fake.offline = true;
    expect(await runner.tickOnce()).toMatchObject({ status: "error", quiet: false });
    expect(dbListLibraryPins()).toHaveLength(1);

    const expired = new LibraryPinRunner({
      ...deps(),
      openSession: async () => {
        const session = fakeSession(fake);
        return {
          ...session,
          client: Object.assign(Object.create(Object.getPrototypeOf(session.client)), session.client, {
            syncPins: async () => {
              throw new CloudAuthError("AUTH_REQUIRED", "login again", { status: 401 });
            },
          }),
        };
      },
    });
    expect(await expired.tickOnce()).toMatchObject({ status: "error", code: "AUTH_REQUIRED", quiet: true });
    expect(dbListLibraryPins()).toHaveLength(1);
  });

  it("reads its interval from RAVI_LIBRARY_PIN_INTERVAL_MS", () => {
    expect(libraryPinIntervalMs({})).toBe(5 * 60_000);
    expect(libraryPinIntervalMs({ RAVI_LIBRARY_PIN_INTERVAL_MS: "60000" })).toBe(60_000);
    expect(libraryPinIntervalMs({ RAVI_LIBRARY_PIN_INTERVAL_MS: "5" })).toBe(10_000);
    expect(libraryPinIntervalMs({ RAVI_LIBRARY_PIN_INTERVAL_MS: "nope" })).toBe(5 * 60_000);
  });
});

describe("library agent report", () => {
  it("reports only the listed agents, with the Console project each scope resolves to", async () => {
    dbCreateAgent({ id: "atendente", cwd: "/tmp/atendente" });
    dbUpdateAgent("atendente", { name: "Atendente", provider: "codex", model: "gpt-x" });
    dbCreateAgent({ id: "financeiro", cwd: "/tmp/financeiro" });
    dbCreateAgent({ id: "rascunho", cwd: "/tmp/rascunho" });
    dbSetLibraryAgentListed("atendente", true);
    // Opening an agent to requests lists it; unlisting closes it again.
    dbSetLibraryAgentAcceptsRequests("financeiro", true);
    dbSetLibraryAgentAcceptsRequests("rascunho", true);
    dbSetLibraryAgentListed("rascunho", false);
    upsertConsoleScopeDefault({
      scopeKind: "agent",
      scopeKey: "atendente",
      consoleUrl: "https://console.test",
      organization: { id: "org-1", slug: "acme" },
      project: { ref: "clinica", slug: "clinica" },
    });
    const reports = await collectLocalAgentReports({
      readCredentials: () => fakeCredentials(),
      listProjects: async () => ({
        success: true,
        consoleUrl: "https://console.test",
        total: 0,
        projects: [],
        items: [],
      }),
      env: { ...process.env, RAVI_CONSOLE_PROJECT_REF: "leaked" },
    });
    const byId = new Map(reports.map((report) => [report.id, report]));
    expect(byId.get("atendente")).toEqual({
      id: "atendente",
      name: "Atendente",
      provider: "codex",
      model: "gpt-x",
      project: "clinica",
      description: null,
      acceptsRequests: false,
    });
    expect(byId.get("financeiro")).toMatchObject({ acceptsRequests: true, project: null });
    expect([...byId.keys()].sort()).toEqual(["atendente", "financeiro"]);
  });
});

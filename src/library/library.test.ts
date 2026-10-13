import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { dbUpsertSkillGrant } from "../router/index.js";
import { resolveAgentSkills } from "../runtime/allowed-skills.js";
import { isLibrarySkillAuthorizedForAgent, isSkillAuthorizedForAgent } from "../runtime/skill-authorization.js";
import { librarySkillCoveredBySkillCapability } from "../runtime/skill-capability-implication.js";
import { extractRequestedSkillsFromCommandLine } from "../runtime/skill-visibility.js";
import type { ContextCapability } from "../router/router-db.js";
import { listCachedVersionDirs, readCachedLibrarySkill, readLibraryIndex } from "./cache.js";
import { openLibrarySession } from "./client.js";
import { LibraryPackageError, readLibraryPackage } from "./package.js";
import { isReservedLibrarySlug, looksLikeLibraryRef, parseLibraryRef } from "./refs.js";
import {
  executeLibraryPublish,
  LibraryCommandError,
  normalizeSearchText,
  prepareLibraryPublish,
  searchSkills,
  showLibrarySkill,
  type LibraryServiceDeps,
} from "./service.js";
import { createFakeConsole, fakeCredentials, fakeSession, fakeSkill, type FakeConsole } from "./test-fixtures.js";

let stateDir: string | null = null;
let workDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-library-");
  workDir = mkdtempSync(join(tmpdir(), "ravi-library-work-"));
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  rmSync(workDir, { recursive: true, force: true });
});

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId, source: "test" };
}

function deps(fake: FakeConsole, project: { slug: string } | null = null, ownTurn = true): LibraryServiceDeps {
  return {
    openSession: async (options) => fakeSession(fake, options.project ? { slug: options.project } : project),
    turn: { operatorOwnTurn: ownTurn },
  };
}

/** An agent with a skill configuration (one local grant), so the gate applies. */
function configuredAgent(id: string, defaults?: Record<string, unknown>) {
  dbCreateAgent({ id, cwd: `/tmp/${id}` });
  if (defaults) dbUpdateAgent(id, { defaults });
  dbUpsertSkillGrant({ agentId: id, skillName: "agents-manager" });
}

describe("library refs", () => {
  it("parses refs and ids to the same item", () => {
    expect(parseLibraryRef("org/agenda-semanal")).toEqual({
      scope: "org",
      project: null,
      slug: "agenda-semanal",
      ref: "org/agenda-semanal",
      id: "org:agenda-semanal",
    });
    expect(parseLibraryRef("Clinica/Triagem")).toMatchObject({
      scope: "project",
      project: "clinica",
      ref: "clinica/triagem",
      id: "project:clinica:triagem",
    });
    expect(parseLibraryRef("org:agenda")?.ref).toBe("org/agenda");
    expect(parseLibraryRef("project:clinica:triagem")?.ref).toBe("clinica/triagem");
  });

  it("rejects malformed refs and bare slugs", () => {
    for (const value of ["agenda", "org/", "/x", "a/b/c", "org/-x", "org/x_y", "project:org:x", "project:x", ""]) {
      expect(parseLibraryRef(value)).toBeNull();
    }
    expect(looksLikeLibraryRef("a/b/c")).toBe(true);
    expect(looksLikeLibraryRef("agenda")).toBe(false);
  });

  it("reserves Ravi's own skill names and the ravi- prefix", () => {
    expect(isReservedLibrarySlug("pages")).toBe(true);
    expect(isReservedLibrarySlug("skill-creator")).toBe(true);
    expect(isReservedLibrarySlug("skills")).toBe(true);
    expect(isReservedLibrarySlug("ravi-anything")).toBe(true);
    expect(isReservedLibrarySlug("agenda-semanal")).toBe(false);
  });

  it("normalizes search text without case or accents", () => {
    expect(normalizeSearchText("Clínica AÇÃO")).toBe("clinica acao");
  });
});

describe("library client and session", () => {
  it("returns no session without a ravi login", async () => {
    expect(await openLibrarySession({}, { readCredentials: () => null })).toBeNull();
  });

  it("binds the session to the org and the explicit project", async () => {
    const fake = createFakeConsole();
    const { ConsoleApiClient } = await import("../cloud-auth/client.js");
    const session = await openLibrarySession(
      { project: "clinica" },
      {
        readCredentials: () => fakeCredentials(),
        client: new ConsoleApiClient({ consoleUrl: "https://console.test", fetch: fake.fetch }),
        getContext: () => undefined,
      },
    );
    expect(session?.orgId).toBe("org-1");
    expect(session?.project?.ref).toBe("clinica");
  });

  it("sends the bearer token and the documented paths", async () => {
    const fake = createFakeConsole([fakeSkill({ slug: "agenda" }), fakeSkill({ slug: "triagem", project: "clinica" })]);
    const session = fakeSession(fake, { slug: "clinica" });
    await session.client.search({ query: "agenda", project: "clinica", limit: 5 });
    await session.client.showRef(parseLibraryRef("clinica/triagem")!);
    await session.client.showSlug("agenda", { project: "clinica" });
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/cli/library/skills?q=agenda&project=clinica&limit=5",
      "GET /api/cli/library/skills/clinica/triagem",
      "GET /api/cli/library/skills/agenda?project=clinica",
    ]);
    expect(fake.requests[0]?.authorization).toBe("Bearer access-1");
  });
});

describe("library show and cache", () => {
  it("loads a ref, writes the cache and serves it offline as stale", async () => {
    const fake = createFakeConsole([fakeSkill({ slug: "agenda", version: 3 })]);
    const shown = await showLibrarySkill({ ref: parseLibraryRef("org/agenda")! }, deps(fake));
    expect(shown).toMatchObject({ stale: false, ref: { ref: "org/agenda" }, version: { number: 3 } });
    expect(shown?.cacheDir && existsSync(join(shown.cacheDir, "references", "guia.md"))).toBe(true);
    expect(listCachedVersionDirs("org-1")).toEqual(["org/agenda@3"]);

    fake.offline = true;
    const offline = await showLibrarySkill({ ref: parseLibraryRef("org/agenda")! }, deps(fake));
    expect(offline?.stale).toBe(true);
    expect(offline?.version.files.find((file) => file.path === "SKILL.md")?.content).toContain("name: agenda");

    const bySlug = await showLibrarySkill({ slug: "agenda" }, deps(fake));
    expect(bySlug?.ref.ref).toBe("org/agenda");
    expect(bySlug?.stale).toBe(true);
  });

  it("fails offline when nothing is cached, and answers null for an unknown bare slug", async () => {
    const fake = createFakeConsole([]);
    expect(await showLibrarySkill({ slug: "nada" }, deps(fake))).toBeNull();
    await expect(showLibrarySkill({ ref: parseLibraryRef("org/nada")! }, deps(fake))).rejects.toMatchObject({
      code: "SKILL_NOT_FOUND",
    });
    fake.offline = true;
    await expect(showLibrarySkill({ ref: parseLibraryRef("org/nada")! }, deps(fake))).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
  });

  it("resolves a bare slug in the caller's view (org plus its project)", async () => {
    const fake = createFakeConsole([fakeSkill({ slug: "triagem", project: "clinica" })]);
    expect(await showLibrarySkill({ slug: "triagem" }, deps(fake))).toBeNull();
    const shown = await showLibrarySkill({ slug: "triagem" }, deps(fake, { slug: "clinica" }));
    expect(shown?.ref.ref).toBe("clinica/triagem");
    expect(listCachedVersionDirs("org-1")).toEqual(["clinica/triagem@1"]);
  });

  it("never writes outside the version directory", async () => {
    const evil = fakeSkill({ slug: "evil" });
    evil.files.push({ path: "../../escape.md", content: "x", bytes: 1, sha256: "" });
    const fake = createFakeConsole([evil]);
    const shown = await showLibrarySkill({ ref: parseLibraryRef("org/evil")! }, deps(fake));
    expect(shown?.cacheDir).toBeNull();
    expect(listCachedVersionDirs("org-1")).toEqual([]);
  });
});

describe("library authorization", () => {
  it("lets the terminal and full-access agents through", () => {
    expect(isSkillAuthorizedForAgent(undefined, "org/agenda")).toBe(true);
    configuredAgent("full", { runtimePermissions: { profile: "full-access" } });
    expect(isSkillAuthorizedForAgent("full", "org/agenda")).toBe(true);
    expect(isSkillAuthorizedForAgent("full", "clinica/triagem")).toBe(true);
  });

  it("denies a configured agent without a grant, then passes after the grant", () => {
    configuredAgent("restricted");
    const none: ContextCapability[] = [];
    expect(isLibrarySkillAuthorizedForAgent("restricted", "org:agenda", { capabilities: none })).toBe(false);
    expect(isSkillAuthorizedForAgent("restricted", "org/agenda", { capabilities: none })).toBe(false);
    dbUpsertSkillGrant({ agentId: "restricted", skillName: "org:agenda" });
    expect(isSkillAuthorizedForAgent("restricted", "org/agenda", { capabilities: none })).toBe(true);
    expect(isSkillAuthorizedForAgent("restricted", "org/outra", { capabilities: none })).toBe(false);
    const resolved = resolveAgentSkills("restricted");
    expect(resolved.libraryGrants).toEqual(["org:agenda"]);
    expect(resolved.allowlist).not.toContain("org:agenda");
  });

  it("matches use:skill capabilities by id and trailing glob, never by slug", () => {
    expect(librarySkillCoveredBySkillCapability([cap("use", "skill", "org:*")], "org:agenda")).toBe(true);
    expect(librarySkillCoveredBySkillCapability([cap("use", "skill", "org:*")], "project:clinica:x")).toBe(false);
    expect(librarySkillCoveredBySkillCapability([cap("use", "skill", "project:clinica:*")], "project:clinica:x")).toBe(
      true,
    );
    expect(librarySkillCoveredBySkillCapability([cap("use", "skill", "project:*")], "project:outra:x")).toBe(true);
    expect(librarySkillCoveredBySkillCapability([cap("use", "skill", "*")], "org:x")).toBe(true);
    expect(librarySkillCoveredBySkillCapability([cap("admin", "system", "*")], "org:x")).toBe(true);
    expect(librarySkillCoveredBySkillCapability([cap("use", "skill", "org-agenda")], "org:agenda")).toBe(false);
  });

  it("lets the runtime gate see Library refs and ignore publish folders", () => {
    expect(extractRequestedSkillsFromCommandLine("ravi skills show org/agenda --json")).toEqual(["org/agenda"]);
    expect(extractRequestedSkillsFromCommandLine("ravi skills publish ./skills/minha --scope org")).toEqual([]);
    expect(extractRequestedSkillsFromCommandLine("ravi skills publish $(cat skills/x/SKILL.md)")).not.toEqual([]);
  });

  it("keeps Library grants and capabilities away from local skills", () => {
    configuredAgent("local-check");
    dbUpsertSkillGrant({ agentId: "local-check", skillName: "org:image" });
    expect(isSkillAuthorizedForAgent("local-check", "image", { capabilities: [] })).toBe(false);
    expect(isSkillAuthorizedForAgent("local-check", "image", { capabilities: [cap("use", "skill", "org:*")] })).toBe(
      false,
    );
  });
});

describe("library external turns and view", () => {
  it("refuses externalAllowed:false outside the operator's own turn, and hides it from search", async () => {
    const fake = createFakeConsole([
      fakeSkill({ slug: "interna" }),
      fakeSkill({ slug: "publica", externalAllowed: true, description: "interna publica" }),
    ]);
    await expect(
      showLibrarySkill({ ref: parseLibraryRef("org/interna")! }, deps(fake, null, false)),
    ).rejects.toMatchObject({ code: "LIBRARY_SKILL_EXTERNAL_DENIED", exitCode: 3 });
    expect(listCachedVersionDirs("org-1")).toEqual([]);
    const allowed = await showLibrarySkill({ ref: parseLibraryRef("org/publica")! }, deps(fake, null, false));
    expect(allowed?.ref.ref).toBe("org/publica");

    const external = await searchSkills({ query: "interna", local: false }, deps(fake, null, false));
    expect(external.items.map((item) => item.ref)).toEqual(["org/publica"]);
    const own = await searchSkills({ query: "interna" }, deps(fake, null, true));
    expect(own.items.map((item) => item.ref).sort()).toEqual(["org/interna", "org/publica"]);
  });

  it("refuses a project item outside the agent's view unless granted", async () => {
    configuredAgent("viewer", { runtimePermissions: { profile: "full-access" } });
    const fake = createFakeConsole([fakeSkill({ slug: "triagem", project: "outra" })]);
    const caller = { agentId: "viewer" };
    const error = await showLibrarySkill(
      { ref: parseLibraryRef("outra/triagem")!, caller },
      deps(fake, { slug: "clinica" }),
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(LibraryCommandError);
    expect(error).toMatchObject({ code: "LIBRARY_SKILL_OUT_OF_VIEW", exitCode: 3 });
    dbUpsertSkillGrant({ agentId: "viewer", skillName: "project:outra:triagem" });
    const shown = await showLibrarySkill(
      { ref: parseLibraryRef("outra/triagem")!, caller },
      deps(fake, { slug: "clinica" }),
    );
    expect(shown?.ref.ref).toBe("outra/triagem");
  });

  it("denies an agent without a grant with SKILL_NOT_AUTHORIZED naming the grant", async () => {
    configuredAgent("no-grant");
    const fake = createFakeConsole([fakeSkill({ slug: "agenda" })]);
    const error = await showLibrarySkill(
      { ref: parseLibraryRef("org/agenda")!, caller: { agentId: "no-grant", capabilities: [] } },
      deps(fake),
    ).catch((caught) => caught);
    expect(error).toMatchObject({ code: "SKILL_NOT_AUTHORIZED", exitCode: 1 });
    expect(String(error.details.suggestedAction)).toContain("ravi skills grant no-grant org/agenda");
  });
});

describe("library search", () => {
  it("merges local and Library results with refs and next commands", async () => {
    const fake = createFakeConsole([
      fakeSkill({ slug: "agenda-semanal", description: "Monta a agenda da semana" }),
      fakeSkill({ slug: "triagem", project: "clinica", description: "Triagem de pacientes" }),
    ]);
    const payload = await searchSkills({ query: "agenda" }, deps(fake, { slug: "clinica" }));
    expect(payload.library.status).toBe("ok");
    const library = payload.items.find((item) => item.ref === "org/agenda-semanal");
    expect(library).toMatchObject({
      source: "library",
      scope: "org",
      version: 1,
      next: "ravi skills show org/agenda-semanal",
    });

    const pages = await searchSkills({ query: "pages" }, deps(fake));
    expect(pages.items[0]).toMatchObject({
      ref: "pages",
      source: "system",
      scope: null,
      next: "ravi skills show pages",
    });
  });

  it("falls back to the cached index when offline, and skips the Library without login", async () => {
    const fake = createFakeConsole([fakeSkill({ slug: "agenda-semanal", description: "Agenda da clínica" })]);
    await searchSkills({ query: "agenda" }, deps(fake));
    expect(Object.keys(readLibraryIndex("org-1").items)).toEqual(["org/agenda-semanal"]);
    fake.offline = true;
    const stale = await searchSkills({ query: "clinica" }, deps(fake));
    expect(stale.stale).toBe(true);
    expect(stale.library.status).toBe("stale");
    expect(stale.items.map((item) => item.ref)).toContain("org/agenda-semanal");

    const skipped = await searchSkills({ query: "agenda" }, { openSession: async () => null });
    expect(skipped.library).toMatchObject({ status: "skipped" });
    expect(skipped.library.hint).toContain("ravi login");
  });

  it("marks authorized for the calling agent", async () => {
    configuredAgent("searcher");
    const fake = createFakeConsole([fakeSkill({ slug: "agenda" })]);
    const payload = await searchSkills(
      { query: "agenda", caller: { agentId: "searcher", capabilities: [] } },
      deps(fake),
    );
    expect(payload.items.find((item) => item.ref === "org/agenda")?.authorized).toBe(false);
    const local = await searchSkills(
      { query: "agents", local: true, caller: { agentId: "searcher", capabilities: [] } },
      deps(fake),
    );
    expect(local.items.find((item) => item.ref === "agents-manager")?.authorized).toBe(true);
  });
});

describe("library publish", () => {
  function skillDir(
    name = "agenda-semanal",
    frontmatter = "name: agenda-semanal\ndescription: Agenda da semana",
  ): string {
    const dir = join(workDir, name);
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Agenda\n`);
    writeFileSync(join(dir, "references", "horarios.md"), "# Horários\n");
    return dir;
  }

  it("plans with the current version and publishes with it as baseVersion", async () => {
    const fake = createFakeConsole([]);
    const dir = skillDir();
    const prepared = await prepareLibraryPublish({ dir, scope: "org", note: "primeira" }, deps(fake));
    expect(prepared.plan).toMatchObject({
      ref: "org/agenda-semanal",
      currentVersion: 0,
      nextVersion: 1,
      unchanged: false,
      files: [
        { file: "SKILL.md", bytes: expect.any(Number) },
        { file: "references/horarios.md", bytes: expect.any(Number) },
      ],
    });
    expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
    const result = await executeLibraryPublish(prepared, deps(fake));
    expect(result).toMatchObject({ ref: "org/agenda-semanal", version: { number: 1 }, unchanged: false });
    expect(fake.requests.at(-1)?.body).toMatchObject({ scope: "org", slug: "agenda-semanal", baseVersion: 0 });

    const again = await prepareLibraryPublish({ dir, scope: "org" }, deps(fake));
    expect(again.plan).toMatchObject({ currentVersion: 1, unchanged: true, nextVersion: 1 });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: agenda-semanal\ndescription: Agenda nova\n---\n\nnovo\n");
    const changed = await prepareLibraryPublish({ dir, scope: "clinica" }, deps(fake));
    expect(changed.plan).toMatchObject({ ref: "clinica/agenda-semanal", currentVersion: 0, project: "clinica" });
  });

  it("refuses bad folders before any request", () => {
    expect(() => readLibraryPackage(join(workDir, "missing"))).toThrow(LibraryPackageError);
    const noDescription = skillDir("sem-descricao", "name: sem-descricao");
    expect(() => readLibraryPackage(noDescription)).toThrow(/description/);
    const reserved = skillDir("pages", "name: pages\ndescription: x");
    expect(() => readLibraryPackage(reserved)).toThrow(expect.objectContaining({ code: "LIBRARY_SLUG_RESERVED" }));
    const big = skillDir("grande", "name: grande\ndescription: x");
    writeFileSync(join(big, "references", "big.md"), "x".repeat(256 * 1024 + 1));
    expect(() => readLibraryPackage(big)).toThrow(/larger than 256 KiB/);
    const badPath = skillDir("caminho", "name: caminho\ndescription: x");
    writeFileSync(join(badPath, "references", "com espaço.md"), "x");
    expect(() => readLibraryPackage(badPath)).toThrow(/File path not allowed/);
    const binary = skillDir("binario", "name: binario\ndescription: x");
    writeFileSync(join(binary, "img.png"), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
    expect(() => readLibraryPackage(binary)).toThrow(/not UTF-8/);
  });

  it("defaults the slug to the folder name and skips dot entries and symlinks", () => {
    const dir = join(workDir, "minha-skill");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: Sem nome\n---\n");
    writeFileSync(join(dir, ".env"), "SECRET=1");
    writeFileSync(join(dir, ".git", "config"), "x");
    symlinkSync("/etc/hosts", join(dir, "hosts"));
    const pkg = readLibraryPackage(dir);
    expect(pkg.slug).toBe("minha-skill");
    expect(pkg.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(pkg.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("caches what it published", async () => {
    const fake = createFakeConsole([]);
    const prepared = await prepareLibraryPublish({ dir: skillDir(), scope: "org" }, deps(fake));
    await executeLibraryPublish(prepared, deps(fake));
    const cached = readCachedLibrarySkill("org-1", "org/agenda-semanal");
    expect(cached?.version.number).toBe(1);
    expect(readFileSync(join(cached!.dir, "references", "horarios.md"), "utf8")).toBe("# Horários\n");
  });
});

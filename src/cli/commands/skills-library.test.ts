import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import { createFakeConsole, fakeCredentials, fakeSkill, type FakeConsole } from "../../library/test-fixtures.js";
import { dbCreateAgent, dbListSkillGrantsForAgent, dbUpdateAgent } from "../../router/router-db.js";
import { dbUpsertSkillGrant } from "../../router/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { SkillsCommands } from "./skills.js";

let stateDir: string | null = null;
let workDir: string;
let fake: FakeConsole;
let fetchSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("skills-library-cli-");
  workDir = mkdtempSync(join(tmpdir(), "skills-library-cli-work-"));
  fake = createFakeConsole([
    fakeSkill({ slug: "agenda-semanal", version: 2, description: "Monta a agenda da semana" }),
    fakeSkill({ slug: "aberta", externalAllowed: true }),
  ]);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) =>
    fake.fetch(String(input instanceof Request ? input.url : input), init)) as typeof fetch);
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
  rmSync(workDir, { recursive: true, force: true });
});

function login() {
  writeCloudCredentials(fakeCredentials());
}

function quiet<T>(run: () => T): T {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function quietAsync<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function contractError(run: () => unknown): Promise<ContractError> {
  let thrown: unknown;
  try {
    await quietAsync(async () => {
      await run();
    });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  return thrown as ContractError;
}

function libraryRequests(): string[] {
  return fake.requests
    .filter((request) => request.path.startsWith("/api/cli/library/"))
    .map((request) => `${request.method} ${request.path}`);
}

function skillDir(name = "agenda-semanal"): string {
  const dir = join(workDir, name);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Agenda da semana\n---\n\n# Agenda\n`);
  writeFileSync(join(dir, "references", "horarios.md"), "# Horários\n");
  return dir;
}

describe("skills show with Library refs", () => {
  it("loads org/<slug> from the Library with ref, version and files", async () => {
    login();
    const payload = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().show("org/agenda-semanal", undefined, undefined, true)),
    );
    expect(payload).toMatchObject({ ref: "org/agenda-semanal", scope: "org", version: 2, stale: false });
    expect(payload.skill).toMatchObject({ name: "org/agenda-semanal", source: "library" });
    expect(payload.files).toEqual(["SKILL.md", "references/guia.md"]);

    const file = await quietAsync(async () =>
      runWithContext({}, () =>
        new SkillsCommands().show("org/agenda-semanal", undefined, undefined, true, "references/guia.md"),
      ),
    );
    expect(file.file).toEqual({ path: "references/guia.md", content: "# Guia\n" });
  });

  it("keeps local skills first: a local name never reaches the Console", () => {
    login();
    const payload = quiet(() =>
      runWithContext({}, () => new SkillsCommands().show("agents-manager", undefined, undefined, true)),
    );
    expect(payload).not.toBeInstanceOf(Promise);
    expect(libraryRequests()).toEqual([]);
  });

  it("resolves a bare slug with no local match in the Library", async () => {
    login();
    const payload = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().show("agenda-semanal", undefined, undefined, true)),
    );
    expect(payload.ref).toBe("org/agenda-semanal");
    expect(libraryRequests()).toEqual(["GET /api/cli/library/skills/agenda-semanal"]);
  });

  it("fails SKILL_NOT_FOUND synchronously for an unknown bare slug without login", async () => {
    const error = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().show("agenda-semanal", undefined, undefined, true)),
    );
    expect(error).toMatchObject({ code: "SKILL_NOT_FOUND", exitCode: 1 });
    expect(String(error.details.suggestedAction)).toContain("ravi login");
  });

  it("refuses a malformed ref with LIBRARY_REF_INVALID (exit 2)", async () => {
    const error = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().show("org/Agenda_x", undefined, undefined, true)),
    );
    expect(error).toMatchObject({ code: "LIBRARY_REF_INVALID", exitCode: 2 });
  });

  it("authorizes the runtime agent: denied without grant, allowed with one", async () => {
    login();
    dbCreateAgent({ id: "atendente", cwd: "/tmp/atendente" });
    dbUpsertSkillGrant({ agentId: "atendente", skillName: "agents-manager" });
    const runAs = () =>
      runWithContext({ transport: "tool", agentId: "atendente" }, () =>
        new SkillsCommands().show("org/aberta", undefined, undefined, true),
      );
    const denied = await contractError(runAs);
    expect(denied).toMatchObject({ code: "SKILL_NOT_AUTHORIZED", exitCode: 1 });
    expect(denied.message).toBe("Skill 'org/aberta' is not authorized for agent 'atendente'.");

    quiet(() => runWithContext({}, () => new SkillsCommands().grant("atendente", "org/aberta", undefined, true)));
    const allowed = await quietAsync(async () => runAs());
    expect(allowed.ref).toBe("org/aberta");
  });

  it("refuses externalAllowed:false in a turn that is not the operator's own (exit 3)", async () => {
    login();
    dbCreateAgent({ id: "publico", cwd: "/tmp/publico" });
    dbUpdateAgent("publico", { defaults: { runtimePermissions: { profile: "full-access" } } });
    const error = await contractError(() =>
      runWithContext({ transport: "tool", agentId: "publico" }, () =>
        new SkillsCommands().show("org/agenda-semanal", undefined, undefined, true),
      ),
    );
    expect(error).toMatchObject({ code: "LIBRARY_SKILL_EXTERNAL_DENIED", exitCode: 3 });
    // The operator's terminal is their own turn.
    const own = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().show("org/agenda-semanal", undefined, undefined, true)),
    );
    expect(own.ref).toBe("org/agenda-semanal");
  });
});

describe("skills search", () => {
  it("merges local and Library results", async () => {
    login();
    const payload = await quietAsync(() =>
      runWithContext({}, () => new SkillsCommands().search("agenda", undefined, undefined, undefined, true)),
    );
    expect(payload.library.status).toBe("ok");
    expect(payload.items.find((item) => item.ref === "org/agenda-semanal")).toMatchObject({
      source: "library",
      next: "ravi skills show org/agenda-semanal",
    });
    const local = await quietAsync(() =>
      runWithContext({}, () => new SkillsCommands().search("pages", undefined, undefined, true, true)),
    );
    expect(local.library.status).toBe("skipped");
    expect(local.items[0]?.ref).toBe("pages");
  });
});

describe("skills publish", () => {
  it("dry-runs with the plan (exit 3) and writes nothing", async () => {
    login();
    const error = await contractError(() =>
      runWithContext({}, () =>
        new SkillsCommands().publish(skillDir(), "org", undefined, undefined, undefined, false, false, true),
      ),
    );
    expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(error.details.plan).toMatchObject({
      ref: "org/agenda-semanal",
      currentVersion: 2,
      nextVersion: 3,
      unchanged: false,
      files: [
        { file: "SKILL.md", bytes: expect.any(Number) },
        { file: "references/horarios.md", bytes: expect.any(Number) },
      ],
    });
    expect(libraryRequests()).toEqual(["GET /api/cli/library/skills/org/agenda-semanal"]);
  });

  it("publishes with --execute using the current version as baseVersion", async () => {
    login();
    const payload = await quietAsync(() =>
      runWithContext({}, () =>
        new SkillsCommands().publish(skillDir("nova-skill"), "clinica", undefined, undefined, "v1", true, true, true),
      ),
    );
    expect(payload).toMatchObject({ success: true, ref: "clinica/nova-skill", version: 1, unchanged: false });
    const post = fake.requests.find((request) => request.method === "POST");
    expect(post?.body).toMatchObject({
      scope: "project",
      project: "clinica",
      slug: "nova-skill",
      baseVersion: 0,
      externalAllowed: true,
      note: "v1",
    });
  });

  it("refuses a missing scope (exit 2) and a reserved slug (exit 2) before any request", async () => {
    login();
    const noScope = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().publish(skillDir(), undefined)),
    );
    expect(noScope).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const reserved = await contractError(() =>
      runWithContext({}, () =>
        new SkillsCommands().publish(skillDir("pages"), "org", undefined, undefined, undefined, false, true, true),
      ),
    );
    expect(reserved).toMatchObject({ code: "LIBRARY_SLUG_RESERVED", exitCode: 2 });
    expect(libraryRequests()).toEqual([]);
  });

  it("asks for ravi login when there is none", async () => {
    const error = await contractError(() =>
      runWithContext({}, () =>
        new SkillsCommands().publish(skillDir(), "org", undefined, undefined, undefined, false, true, true),
      ),
    );
    expect(error.code).toBe("AUTH_REQUIRED");
  });
});

describe("skills grant/revoke with Library refs", () => {
  it("stores the normalized id and revokes by ref or id", () => {
    dbCreateAgent({ id: "grantee", cwd: "/tmp/grantee" });
    const commands = new SkillsCommands();
    const granted = quiet(() =>
      runWithContext({}, () => commands.grant("grantee", "Clinica/Triagem", undefined, true)),
    );
    expect(granted.skillName).toBe("project:clinica:triagem");
    expect(dbListSkillGrantsForAgent("grantee").map((grant) => grant.skillName)).toEqual(["project:clinica:triagem"]);
    const who = quiet(() => runWithContext({}, () => commands.who("clinica/triagem", undefined, true)));
    expect(who.total).toBe(1);
    const inspect = quiet(() => runWithContext({}, () => commands.inspect("grantee", true)));
    expect(inspect.libraryGrants).toEqual(["project:clinica:triagem"]);
    const revoked = quiet(() => runWithContext({}, () => commands.revoke("grantee", "project:clinica:triagem", true)));
    expect(revoked).toMatchObject({ success: true, skillName: "project:clinica:triagem" });
  });

  it("rejects malformed and reserved refs", async () => {
    dbCreateAgent({ id: "grantee2", cwd: "/tmp/grantee2" });
    const commands = new SkillsCommands();
    const invalid = await contractError(() =>
      runWithContext({}, () => commands.grant("grantee2", "org/", undefined, true)),
    );
    expect(invalid).toMatchObject({ code: "LIBRARY_REF_INVALID", exitCode: 2 });
    const reserved = await contractError(() =>
      runWithContext({}, () => commands.grant("grantee2", "org/pages", undefined, true)),
    );
    expect(reserved).toMatchObject({ code: "LIBRARY_SLUG_RESERVED", exitCode: 2 });
  });
});

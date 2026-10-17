import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import {
  createFakeConsole,
  FAKE_CONSOLE_URL,
  fakeComment,
  fakeCredentials,
  fakeProposal,
  fakeSkill,
  type FakeConsole,
} from "../../library/test-fixtures.js";
import { setLibraryConfigChangedEmitterForTests } from "../../library/pins.js";
import { dbListLibraryPins } from "../../library/pins-db.js";
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
  fake.proposals = [];
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

async function captureAsync<T>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const log = console.log;
  const error = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = () => {};
  try {
    return { result: await run(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
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
        new SkillsCommands().publish(skillDir(), "org", undefined, undefined, undefined, false, true, false),
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

describe("skills propose", () => {
  const propose = (
    dir: string,
    options: {
      scope?: string;
      draft?: boolean;
      update?: string;
      rebase?: boolean;
      external?: boolean;
      asJson?: boolean;
      execute?: boolean;
    } = {},
  ) =>
    new SkillsCommands().propose(
      dir,
      options.scope ?? "org",
      undefined,
      undefined,
      undefined,
      options.external,
      options.draft,
      options.update,
      options.rebase,
      options.asJson ?? true,
      options.execute,
    );

  it("dry-runs with the plan (exit 3) and only reads", async () => {
    login();
    const error = await contractError(() => runWithContext({}, () => propose(skillDir())));
    expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(error.details.plan).toMatchObject({
      ref: "org/agenda-semanal",
      exists: true,
      currentVersion: 2,
      baseVersion: 2,
      submit: true,
      update: null,
      stale: false,
      unchanged: false,
      files: [
        { file: "SKILL.md", bytes: expect.any(Number) },
        { file: "references/horarios.md", bytes: expect.any(Number) },
      ],
    });
    expect(libraryRequests()).toEqual([
      "GET /api/cli/library/skills/org/agenda-semanal",
      "GET /api/cli/library/skills/org/agenda-semanal/proposals",
    ]);
  });

  it("proposes a new item from an agent runtime with submit, baseVersion and the agent", async () => {
    login();
    const { result, lines } = await captureAsync(() =>
      runWithContext({ transport: "tool", agentId: "autor" }, () =>
        propose(skillDir("nova-skill"), { asJson: false, execute: true }),
      ),
    );
    expect(result).toMatchObject({
      success: true,
      ref: "org/nova-skill",
      number: 1,
      status: "proposed",
      created: true,
    });
    const post = fake.requests.find((request) => request.method === "POST");
    expect(post).toMatchObject({
      path: "/api/cli/library/skills/proposals",
      body: { scope: "org", slug: "nova-skill", baseVersion: 0, submit: true, agent: { id: "autor" } },
    });
    expect(lines[0]).toBe("✓ Proposed org/nova-skill (proposal 1), waiting for review");
    expect(lines.at(-1)).toBe("  Follow it with: ravi skills proposal org/nova-skill 1");
  });

  it("saves a draft with --draft", async () => {
    login();
    const { result, lines } = await captureAsync(() =>
      runWithContext({}, () => propose(skillDir("rascunho"), { draft: true, asJson: false, execute: true })),
    );
    expect(result.status).toBe("draft");
    expect(fake.requests.find((request) => request.method === "POST")?.body).toMatchObject({ submit: false });
    expect(lines[0]).toContain("✓ Saved draft org/rascunho (proposal 1)");
  });

  it("updates a stale draft keeping its base, and moves it with --rebase", async () => {
    login();
    fake.proposals.push(fakeProposal({ slug: "agenda-semanal", number: 3, baseVersion: 1, status: "draft" }));
    const dir = skillDir();
    const plan = await contractError(() => runWithContext({}, () => propose(dir, { update: "3" })));
    expect(plan.details.plan).toMatchObject({ update: 3, baseVersion: 1, currentVersion: 2, stale: true });

    const kept = await quietAsync(() => runWithContext({}, () => propose(dir, { update: "3", execute: true })));
    expect(kept).toMatchObject({ created: false, status: "proposed", baseVersion: 1, stale: true });
    const firstUpdate = fake.requests.filter((request) => request.method === "POST").at(-1);
    expect(firstUpdate?.path).toBe("/api/cli/library/skills/org/agenda-semanal/proposals/3/update");
    expect(firstUpdate?.body).toMatchObject({ submit: true });
    expect(firstUpdate?.body).not.toHaveProperty("baseVersion");

    const rebased = await quietAsync(() =>
      runWithContext({}, () => propose(dir, { update: "3", rebase: true, execute: true })),
    );
    expect(rebased).toMatchObject({ baseVersion: 2, stale: false, round: 2 });
    expect(fake.requests.filter((request) => request.method === "POST").at(-1)?.body).toMatchObject({
      baseVersion: 2,
    });
  });

  it("refuses a bad --update and --rebase without --update (exit 2)", async () => {
    login();
    const bad = await contractError(() => runWithContext({}, () => propose(skillDir(), { update: "x" })));
    expect(bad).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const rebase = await contractError(() => runWithContext({}, () => propose(skillDir(), { rebase: true })));
    expect(rebase).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    expect(libraryRequests()).toEqual([]);
  });

  it("maps unchanged and stale_base conflicts to their next step", async () => {
    login();
    const published = fake.skills[0]!;
    const dir = join(workDir, "agenda-semanal");
    mkdirSync(join(dir, "references"), { recursive: true });
    for (const file of published.files) writeFileSync(join(dir, ...file.path.split("/")), file.content);
    const same = await contractError(() => runWithContext({}, () => propose(dir, { execute: true })));
    expect(same).toMatchObject({ code: "CONFLICT", details: { conflict: "unchanged" } });
    expect(String(same.details.suggestedAction)).toContain("nothing to propose");

    // Someone publishes between the plan and the POST.
    fetchSpy?.mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") published.item.version = 3;
      return fake.fetch(String(input instanceof Request ? input.url : input), init);
    }) as typeof fetch);
    const stale = await contractError(() => runWithContext({}, () => propose(skillDir(), { execute: true })));
    expect(stale).toMatchObject({ code: "CONFLICT", details: { conflict: "stale_base", currentVersion: 3 } });
    expect(String(stale.details.suggestedAction)).toContain("ravi skills show <ref>");
  });
});

describe("skills proposals and proposal", () => {
  beforeEach(() => {
    fake.proposals.push(
      fakeProposal({
        slug: "agenda-semanal",
        number: 2,
        baseVersion: 1,
        author: { name: "Op", agentId: "atendente", self: true },
        note: "horários de sábado",
        comments: [
          fakeComment({ id: "c1", body: "Falta o sábado", path: "SKILL.md", line: 4, round: 1, outdated: true }),
          fakeComment({
            id: "c2",
            parentId: "c1",
            body: "Ok, vou ajustar",
            author: { name: "Op", agentId: "atendente", self: true },
          }),
          fakeComment({ id: "c3", body: "Ficou bom", resolvedAt: "2026-10-16T01:00:00.000Z" }),
        ],
      }),
    );
  });

  it("lists rows with ref, number, status, stale, author and open comments", async () => {
    login();
    const { result, lines } = await captureAsync(() =>
      runWithContext({}, () => new SkillsCommands().proposals(undefined, undefined, undefined, undefined, false)),
    );
    expect(result).toMatchObject({ state: "open", total: 1 });
    expect(result.proposals[0]).toMatchObject({
      next: "ravi skills proposal org/agenda-semanal 2",
      openComments: 1,
      reviewUrl: `${FAKE_CONSOLE_URL}/org/library/org/agenda-semanal/proposals/2`,
    });
    expect(lines).toEqual([
      "org/agenda-semanal #2 proposed [stale] — agent atendente for Op — 1 open comment",
      "  ravi skills proposal org/agenda-semanal 2",
    ]);
    const item = await quietAsync(() =>
      runWithContext({}, () => new SkillsCommands().proposals("org/agenda-semanal", undefined, "all", undefined, true)),
    );
    expect(item).toMatchObject({ ref: "org/agenda-semanal", total: 1, item: { version: 2 } });
    expect(libraryRequests().at(-1)).toBe("GET /api/cli/library/skills/org/agenda-semanal/proposals");
  });

  it("refuses a bad --state (exit 2)", async () => {
    login();
    const error = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().proposals(undefined, undefined, "pending", undefined, true)),
    );
    expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
  });

  it("shows status, files and the review comments", async () => {
    login();
    const { result, lines } = await captureAsync(() =>
      runWithContext({}, () => new SkillsCommands().proposal("org/agenda-semanal", "2", false)),
    );
    expect(result).toMatchObject({ ref: "org/agenda-semanal", number: 2, contentsVisible: true, base: { number: 1 } });
    expect(result.files[0]).toMatchObject({ path: "SKILL.md", content: expect.any(String) });
    expect(lines).toContain("Author: agent atendente for Op");
    expect(lines).toContain("Note: horários de sábado");
    expect(lines.some((line) => line.startsWith("Stale: version 2 was published"))).toBe(true);
    expect(lines).toContain("Comments (1 open):");
    expect(lines).toContain("  SKILL.md:4 [outdated, round 1] Ana: Falta o sábado");
    expect(lines).toContain("    ↳ agent atendente for Op: Ok, vou ajustar");
    expect(lines).toContain("  [resolved] Ana: Ficou bom");
    expect(lines.at(-1)).toBe(
      "Answer the review by updating it: ravi skills propose <dir> --scope org --update 2 --execute",
    );
  });

  it("answers NOT_FOUND for an unknown proposal and LIBRARY_REF_INVALID for a bad ref", async () => {
    login();
    const missing = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().proposal("org/agenda-semanal", "9", true)),
    );
    expect(missing).toMatchObject({ code: "NOT_FOUND", exitCode: 1 });
    const invalid = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().proposal("agenda", "1", true)),
    );
    expect(invalid).toMatchObject({ code: "LIBRARY_REF_INVALID", exitCode: 2 });
  });
});

describe("skills publish inside an agent", () => {
  it("is refused with LIBRARY_AGENT_CANNOT_PUBLISH (exit 3) before any request", async () => {
    login();
    const error = await contractError(() =>
      runWithContext({ transport: "tool", agentId: "autor" }, () =>
        new SkillsCommands().publish(skillDir(), "org", undefined, undefined, undefined, false, true, true),
      ),
    );
    expect(error).toMatchObject({ code: "LIBRARY_AGENT_CANNOT_PUBLISH", exitCode: 3 });
    expect(error.details.suggestedAction).toBe("ravi skills propose <dir> --scope org --execute");
    expect(fake.requests).toEqual([]);
  });
});

describe("skills pin, unpin and pins", () => {
  beforeEach(() => {
    setLibraryConfigChangedEmitterForTests(() => {});
  });
  afterEach(() => {
    setLibraryConfigChangedEmitterForTests(null);
  });

  it("is refused inside an agent with LIBRARY_AGENT_CANNOT_PIN (exit 3) before any request", async () => {
    login();
    const runs: Array<() => Promise<unknown>> = [
      () => new SkillsCommands().pin("org/aberta", "main", true, true),
      () => new SkillsCommands().unpin("org/aberta", "main", true),
    ];
    for (const run of runs) {
      const error = await contractError(() => runWithContext({ transport: "tool", agentId: "main" }, run));
      expect(error).toMatchObject({ code: "LIBRARY_AGENT_CANNOT_PIN", exitCode: 3 });
      expect(error.details.suggestedAction).toBe(
        "Ask the operator to run: ravi skills pin <ref> --agent <agent> --execute",
      );
    }
    expect(fake.requests).toEqual([]);
  });

  it("checks the ref and the agent before any request", async () => {
    login();
    const noAgent = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().pin("org/aberta", undefined, true)),
    );
    expect(noAgent).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const unknown = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().pin("org/aberta", "ninguem", true)),
    );
    expect(unknown).toMatchObject({ code: "AGENT_NOT_FOUND", exitCode: 1 });
    const bare = await contractError(() => runWithContext({}, () => new SkillsCommands().pin("aberta", "main", true)));
    expect(bare).toMatchObject({ code: "LIBRARY_REF_INVALID", exitCode: 2 });
    expect(fake.requests).toEqual([]);
  });

  it("plans a pin (exit 3), then pins with --execute and loads it locally", async () => {
    login();
    const plan = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().pin("org/agenda-semanal", "main", true)),
    );
    expect(plan).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(libraryRequests()).toEqual(["GET /api/cli/library/skills/org/agenda-semanal"]);
    expect(fake.pins).toEqual([]);

    const result = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().pin("org/agenda-semanal", "main", true, true)),
    );
    expect(result).toMatchObject({
      success: true,
      ref: "org/agenda-semanal",
      agent: "main",
      created: true,
      local: { pinned: true, refreshed: true, skill: "org-agenda-semanal" },
    });
    expect(libraryRequests()).toContain("POST /api/cli/library/pins/sync");
    expect(libraryRequests()).toContain("POST /api/cli/library/skills/org/agenda-semanal/pin");
    expect(dbListLibraryPins().map((row) => [row.agentId, row.ref])).toEqual([["main", "org/agenda-semanal"]]);
  });

  it("maps pin conflicts to details.conflict with a next step", async () => {
    login();
    fake.skills.push(fakeSkill({ slug: "triagem", project: "clinica" }));
    const error = await contractError(() =>
      runWithContext({}, () => new SkillsCommands().pin("clinica/triagem", "main", true, true)),
    );
    expect(error).toMatchObject({ code: "CONFLICT", exitCode: 1, details: { conflict: "agent_out_of_scope" } });
    expect(String(error.details.suggestedAction)).toContain("ravi cloud scope set --agent");
  });

  it("unpins at once (no --execute) and lists pins, locally and per item", async () => {
    login();
    await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().pin("org/agenda-semanal", "main", true, true)),
    );
    const listed = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().pins(undefined, undefined, true)),
    );
    expect(listed).toMatchObject({
      stale: false,
      total: 1,
      pins: [{ agent: "main", ref: "org/agenda-semanal", skill: "org-agenda-semanal", version: 2 }],
    });
    const itemPins = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().pins("org/agenda-semanal", undefined, true)),
    );
    expect(itemPins).toMatchObject({
      ref: "org/agenda-semanal",
      installationId: "inst-1",
      can: { pin: true },
      pins: [{ agent: { id: "main" }, installation: { id: "inst-1" } }],
    });
    const { lines } = await captureAsync(async () =>
      runWithContext({}, () => new SkillsCommands().pins(undefined, undefined, false)),
    );
    expect(lines).toContain(
      "main: org/agenda-semanal v2 as ravi-library:org-agenda-semanal (operator's own turns only)",
    );

    const unpinned = await quietAsync(async () =>
      runWithContext({}, () => new SkillsCommands().unpin("org/agenda-semanal", "main", true)),
    );
    expect(unpinned).toMatchObject({ success: true, removed: true, local: { pinned: false, refreshed: true } });
    expect(dbListLibraryPins()).toEqual([]);
  });
});

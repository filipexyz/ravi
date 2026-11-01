import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import {
  createFakeConsole,
  fakeCredentials,
  fakeItem,
  json,
  type FakeConsole,
  type FakeRoute,
} from "../../library/test-fixtures.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { themeUseReturnSchema } from "../library-contract.js";
import { ThemesCommands } from "./themes.js";

const THEME_JSON = JSON.stringify({
  $description: "Tema da Acme",
  $extensions: { ravi: { name: "Acme" } },
  color: { light: { text: { primary: { $type: "color", $value: "#111111" } } } },
});

const CONTRAST_OK = {
  ok: true,
  checks: [{ mode: "light", pair: ["text.primary", "surface.page"], ratio: 12.6, min: 4.5, ok: true }],
};

let stateDir: string | null = null;
let workDir: string;
let fake: FakeConsole;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
/** What `POST themes/check` answers; tests replace it. */
let checkAnswer: () => Response;
/** What `POST themes` (publish) answers when set; otherwise the fake's own publish. */
let publishAnswer: (() => Response) | null;
/** The ref the fake's pointer names now (`POST themes/active` reports it as `from`). */
let activeRef: string | null;

const routes: FakeRoute = ({ method, rest, body }) => {
  if (method === "POST" && rest[0] === "check" && rest.length === 1) return checkAnswer();
  if (method === "POST" && rest.length === 0 && publishAnswer) return publishAnswer();
  if (method === "GET" && rest[0] === "default" && rest.length === 1) {
    return json(200, {
      files: [
        { path: "theme.json", content: THEME_JSON },
        { path: "fields.json", content: '{ "types": {} }\n' },
      ],
      diagnostics: [],
    });
  }
  if (method === "GET" && rest[0] === "active" && rest.length === 1) {
    return json(200, {
      org: { ref: "org/acme", itemId: "i-1", scope: "org", slug: "acme", name: "Acme", setAt: null, setBy: "Op" },
      project: null,
      effective: { ref: "org/acme", itemId: "i-1", scope: "org", slug: "acme", name: "Acme", version: 3, hash: "h" },
      warnings: [],
    });
  }
  if (method === "POST" && rest[0] === "active" && rest.length === 1) {
    const input = body as { scope: string; project?: string; ref: string | null; dryRun?: boolean };
    // Like the Console: the project as an object, and `applied: true, unchanged: true` when the pointer already names it.
    const unchanged = input.ref === activeRef;
    return json(200, {
      plan: {
        scope: input.scope,
        project: input.project ? { id: `p-${input.project}`, slug: input.project, name: "Clínica" } : null,
        from: activeRef ? { ref: activeRef, itemId: "i-0", scope: "org", slug: "old", name: "Old" } : null,
        to: input.ref ? { ref: input.ref, itemId: "i-1", scope: "org", slug: "acme", name: "Acme" } : null,
        affectedHosts: [{ siteSlug: "clinica", hostname: "acme-clinica.ravi.page", routes: 2 }],
      },
      applied: input.dryRun !== true,
      unchanged,
    });
  }
  return null;
};

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("themes-cli-");
  workDir = mkdtempSync(join(tmpdir(), "themes-cli-work-"));
  checkAnswer = () => json(200, { ok: true, diagnostics: [], contrast: CONTRAST_OK, css: ":root{}" });
  publishAnswer = null;
  activeRef = "org/old";
  fake = createFakeConsole([], [], { kind: "theme", routes });
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

async function capture<T>(run: () => Promise<T>): Promise<{ result: T; out: string[]; err: string[] }> {
  const log = console.log;
  const error = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => err.push(args.map(String).join(" "));
  try {
    return { result: await run(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function contractError(run: () => unknown): Promise<{ error: ContractError; out: string[]; err: string[] }> {
  let thrown: unknown;
  const captured = await capture(async () => {
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
  });
  expect(thrown).toBeInstanceOf(ContractError);
  return { error: thrown as ContractError, out: captured.out, err: captured.err };
}

function libraryRequests(): string[] {
  return fake.requests
    .filter((request) => request.path.startsWith("/api/cli/library/"))
    .map((request) => `${request.method} ${request.path}`);
}

function themeDir(name = "acme"): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "theme.json"), THEME_JSON);
  writeFileSync(join(dir, "fields.json"), '{ "types": { "date": "relative" } }\n');
  return dir;
}

const operator = <T>(run: () => T) => runWithContext({}, run);
const agent = <T>(run: () => T) => runWithContext({ transport: "tool", agentId: "designer" }, run);

describe("themes publish", () => {
  it("checks the folder, then dry-runs with the plan (exit 3) and publishes nothing", async () => {
    login();
    const { error } = await contractError(() =>
      operator(() => new ThemesCommands().publish(themeDir(), "org", undefined, undefined, undefined, true, false)),
    );
    expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(error.details.plan).toMatchObject({
      ref: "org/acme",
      kind: "theme",
      currentVersion: 0,
      nextVersion: 1,
      files: [
        { file: "fields.json", bytes: expect.any(Number) },
        { file: "theme.json", bytes: expect.any(Number) },
      ],
    });
    expect(libraryRequests()).toContain("POST /api/cli/library/themes/check");
    expect(libraryRequests()).not.toContain("POST /api/cli/library/themes");
  });

  it("publishes with --execute, taking name and description from theme.json", async () => {
    login();
    const { result, out } = await capture(() =>
      operator(() => new ThemesCommands().publish(themeDir(), "org", undefined, undefined, "v1", false, true)),
    );
    expect(result).toMatchObject({ success: true, ref: "org/acme", version: 1, unchanged: false, diagnostics: [] });
    const post = fake.requests.find(
      (request) => request.method === "POST" && request.path === "/api/cli/library/themes",
    );
    expect(post?.body).toMatchObject({
      scope: "org",
      slug: "acme",
      name: "Acme",
      description: "Tema da Acme",
      baseVersion: 0,
      note: "v1",
    });
    expect(out.join("\n")).toContain("ravi themes use org/acme --execute");
  });

  it("is refused inside an agent turn (exit 3) before any request", async () => {
    login();
    const { error } = await contractError(() =>
      agent(() => new ThemesCommands().publish(themeDir(), "org", undefined, undefined, undefined, true, true)),
    );
    expect(error).toMatchObject({ code: "LIBRARY_AGENT_CANNOT_PUBLISH", exitCode: 3 });
    expect(String(error.details.suggestedAction)).toContain(`ravi themes propose ${themeDir()} --scope org --execute`);
    expect(libraryRequests()).toEqual([]);
  });

  it("stops on check errors with THEME_INVALID (exit 2) and file:line:column lines", async () => {
    login();
    checkAnswer = () =>
      json(200, {
        ok: false,
        diagnostics: [
          {
            severity: "error",
            code: "THEME_TOKEN_UNKNOWN",
            message: "Unknown token color.brand.",
            file: "theme.json",
            line: 3,
            column: 5,
          },
          { severity: "warning", code: "THEME_FONT_REMOTE", message: "Remote font.", file: "theme.json", line: 9 },
        ],
        contrast: {
          ok: false,
          checks: [{ mode: "dark", pair: ["text.muted", "surface.page"], ratio: 3.1, min: 4.5, ok: false }],
        },
        css: null,
      });
    const { error, err } = await contractError(() =>
      operator(() => new ThemesCommands().publish(themeDir(), "org", undefined, undefined, undefined, false, true)),
    );
    expect(error).toMatchObject({ code: "THEME_INVALID", exitCode: 2 });
    expect(error.details).toMatchObject({ errors: 1, warnings: 1, contrast: { ok: false } });
    expect(error.details.issues).toContainEqual({
      path: ["theme.json", 3, 5],
      code: "THEME_TOKEN_UNKNOWN",
      message: "Unknown token color.brand.",
      severity: "error",
    });
    expect(err[0]).toBe("theme.json:3:5 error THEME_TOKEN_UNKNOWN Unknown token color.brand.");
    expect(err[1]).toBe("theme.json:9 warning THEME_FONT_REMOTE Remote font.");
    expect(err.join("\n")).toContain("text.muted");
    expect(libraryRequests()).not.toContain("POST /api/cli/library/themes");
  });

  it("refuses the reserved slugs none and default (exit 2) before any request", async () => {
    login();
    const byFolder = await contractError(() =>
      operator(() =>
        new ThemesCommands().publish(themeDir("none"), "org", undefined, undefined, undefined, true, true),
      ),
    );
    expect(byFolder.error).toMatchObject({ code: "LIBRARY_SLUG_RESERVED", exitCode: 2 });
    const bySlug = await contractError(() =>
      operator(() => new ThemesCommands().publish(themeDir(), "org", "default", undefined, undefined, true, true)),
    );
    expect(bySlug.error).toMatchObject({ code: "LIBRARY_SLUG_RESERVED", exitCode: 2 });
    expect(fake.requests).toEqual([]);
  });

  it("maps a Console PAYLOAD_INVALID with diagnostics to THEME_INVALID (exit 2)", async () => {
    login();
    publishAnswer = () =>
      json(400, {
        error: {
          code: "PAYLOAD_INVALID",
          message: "The theme does not compile.",
          details: {
            diagnostics: [
              { severity: "error", code: "THEME_JSON_INVALID", message: "Bad JSON.", file: "theme.json", line: 1 },
            ],
          },
        },
      });
    const { error, err } = await contractError(() =>
      operator(() => new ThemesCommands().publish(themeDir(), "org", undefined, undefined, undefined, false, true)),
    );
    expect(error).toMatchObject({ code: "THEME_INVALID", exitCode: 2 });
    expect(err[0]).toBe("theme.json:1 error THEME_JSON_INVALID Bad JSON.");
  });
});

describe("themes check", () => {
  it("returns the compile result and contrast checks", async () => {
    login();
    const { result, out } = await capture(() => operator(() => new ThemesCommands().check(themeDir())));
    expect(result).toMatchObject({ kind: "theme", ok: true, diagnostics: [], css: ":root{}" });
    expect(result.contrast?.checks).toHaveLength(1);
    expect(out[0]).toContain("The theme compiles");
  });

  it("needs a theme.json (exit 2) without asking the Console", async () => {
    login();
    const dir = join(workDir, "vazio");
    mkdirSync(dir);
    const { error } = await contractError(() => operator(() => new ThemesCommands().check(dir)));
    expect(error.exitCode).toBe(2);
    expect(libraryRequests()).toEqual([]);
  });
});

describe("themes init", () => {
  it("writes the default theme and refuses to overwrite without --force (exit 3)", async () => {
    login();
    const dir = join(workDir, "novo");
    const first = await capture(() => operator(() => new ThemesCommands().init(dir, false, true)));
    expect(first.result.files.map((file) => file.file)).toEqual(["theme.json", "fields.json"]);
    expect(readFileSync(join(dir, "theme.json"), "utf8")).toBe(THEME_JSON);

    writeFileSync(join(dir, "theme.json"), "{}");
    const { error } = await contractError(() => operator(() => new ThemesCommands().init(dir, false, true)));
    expect(error).toMatchObject({ code: "LIBRARY_FILES_EXIST", exitCode: 3 });
    expect(readFileSync(join(dir, "theme.json"), "utf8")).toBe("{}");

    const forced = await capture(() => operator(() => new ThemesCommands().init(dir, true, true)));
    expect(forced.result.files.find((file) => file.file === "theme.json")?.overwritten).toBe(true);
    expect(readFileSync(join(dir, "theme.json"), "utf8")).toBe(THEME_JSON);
  });
});

describe("themes use", () => {
  it("plans with dryRun first and exits 3 listing the Pages hosts it reaches", async () => {
    login();
    const { error, out } = await contractError(() => operator(() => new ThemesCommands().use("org/acme")));
    expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(error.details.plan).toMatchObject({
      ref: "org/acme",
      scope: "org",
      affectedHosts: [{ hostname: "acme-clinica.ravi.page", routes: 2 }],
    });
    const posts = fake.requests.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ scope: "org", ref: "org/acme", dryRun: true });
    expect(out.join("\n")).toContain("acme-clinica.ravi.page (2 routes)");
  });

  it("applies with --execute after the dry run", async () => {
    login();
    const { result } = await capture(() => operator(() => new ThemesCommands().use("org/acme", "clinica", true, true)));
    expect(result).toMatchObject({
      success: true,
      applied: true,
      unchanged: false,
      plan: { scope: "project", project: { id: "p-clinica", slug: "clinica", name: "Clínica" } },
    });
    expect(themeUseReturnSchema.safeParse(result).success).toBe(true);
    const bodies = fake.requests.filter((request) => request.method === "POST").map((request) => request.body);
    expect(bodies).toEqual([
      { scope: "project", project: "clinica", ref: "org/acme", dryRun: true },
      { scope: "project", project: "clinica", ref: "org/acme", dryRun: false },
    ]);
  });

  it("names the project the Console sends in the plan, as text and in the dry-run JSON", async () => {
    login();
    const dryRun = await contractError(() => operator(() => new ThemesCommands().use("org/acme", "clinica")));
    expect(dryRun.out[0]).toBe("Active theme for project clinica (Clínica): org/old (Old) → org/acme (Acme)");
    expect(dryRun.error.details.plan).toMatchObject({
      project: { id: "p-clinica", slug: "clinica", name: "Clínica" },
      unchanged: false,
    });

    const { out } = await capture(() => operator(() => new ThemesCommands().use("org/acme", "clinica", false, true)));
    expect(out[0]).toBe("Active theme for project clinica (Clínica): org/old (Old) → org/acme (Acme)");
    expect(out.at(-1)).toStartWith("✓ Saved.");
  });

  it("reports nothing changed when the Console answers applied with unchanged", async () => {
    login();
    activeRef = "org/acme";
    const dryRun = await contractError(() => operator(() => new ThemesCommands().use("org/acme")));
    expect(dryRun.error.details.plan).toMatchObject({ unchanged: true });
    expect(dryRun.out).toContain("That is already the active theme: --execute would change nothing.");

    const executed = await capture(() => operator(() => new ThemesCommands().use("org/acme", undefined, true, true)));
    expect(executed.result).toMatchObject({ success: true, applied: false, unchanged: true });
    expect(themeUseReturnSchema.safeParse(executed.result).success).toBe(true);

    const text = await capture(() => operator(() => new ThemesCommands().use("org/acme", undefined, false, true)));
    expect(text.out.at(-1)).toBe("= Nothing changed: that is already the active theme.");
    expect(text.out.join("\n")).not.toContain("Saved");
  });

  it("clears the pointer with none", async () => {
    login();
    const { result } = await capture(() => operator(() => new ThemesCommands().use("none", undefined, true, true)));
    expect(result.plan.to).toBeNull();
    expect(fake.requests.at(-1)?.body).toEqual({ scope: "org", ref: null, dryRun: false });
  });

  it("is refused inside an agent turn (exit 3) before any request", async () => {
    login();
    const { error } = await contractError(() =>
      agent(() => new ThemesCommands().use("org/acme", undefined, true, true)),
    );
    expect(error).toMatchObject({ code: "LIBRARY_AGENT_CANNOT_SET_THEME", exitCode: 3 });
    expect(String(error.details.suggestedAction)).toBe("Ask the operator to run: ravi themes use org/acme --execute");
    expect(fake.requests).toEqual([]);
  });

  it("refuses a malformed ref (exit 2)", async () => {
    login();
    const { error } = await contractError(() => operator(() => new ThemesCommands().use("Org/Acme_x")));
    expect(error.exitCode).toBe(2);
    expect(fake.requests.filter((request) => request.method === "POST")).toEqual([]);
  });
});

describe("themes active", () => {
  it("prints the org pointer and the effective theme", async () => {
    login();
    const { result, out } = await capture(() => operator(() => new ThemesCommands().active()));
    expect(result).toMatchObject({
      org: { ref: "org/acme", setBy: "Op" },
      project: null,
      effective: { ref: "org/acme", version: 3, source: "org" },
    });
    expect(out[0]).toBe("Org theme: org/acme (Acme)");
    expect(out.join("\n")).toContain("Effective: org/acme v3 (from the org)");
  });
});

describe("themes show and search", () => {
  it("reads a published theme and lists it in search", async () => {
    login();
    fake.skills = [
      fakeItem({
        kind: "theme",
        slug: "acme",
        description: "Tema da Acme",
        version: 2,
        files: [{ path: "theme.json", content: THEME_JSON }],
      }),
    ];
    const shown = await capture(() =>
      operator(() => new ThemesCommands().show("org/acme", undefined, undefined, true)),
    );
    expect(shown.result).toMatchObject({ ref: "org/acme", kind: "theme", version: 2 });
    const found = await capture(() => operator(() => new ThemesCommands().search("acme", undefined, undefined, true)));
    expect(found.result.items.map((item) => item.ref)).toEqual(["org/acme"]);
  });

  it("refuses a reserved route word as a slug (exit 2) before any request, naming the right command", async () => {
    login();
    const hints: Record<string, string> = {
      active: "Use: ravi themes active",
      default: "Use: ravi themes init <dir>",
      none: "Use: ravi themes active",
      check: "Use: ravi themes check <dir>",
      proposals: "Use: ravi themes proposals",
    };
    for (const [word, hint] of Object.entries(hints)) {
      const { error } = await contractError(() =>
        operator(() => new ThemesCommands().show(word.toUpperCase(), undefined, undefined, true)),
      );
      expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
      expect(error.details.suggestedAction).toBe(hint);
    }
    expect(fake.requests).toEqual([]);
  });

  it("fails THEME_NOT_FOUND (exit 1) for an unknown ref", async () => {
    login();
    const { error } = await contractError(() =>
      operator(() => new ThemesCommands().show("org/nada", undefined, undefined, true)),
    );
    expect(error).toMatchObject({ code: "THEME_NOT_FOUND", exitCode: 1 });
  });
});

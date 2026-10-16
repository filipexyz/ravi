import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import {
  createFakeConsole,
  fakeCredentials,
  json,
  type FakeConsole,
  type FakeRoute,
} from "../../library/test-fixtures.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { WidgetsCommands } from "./widgets.js";

const VIEW_ID = "0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";

const WIDGET_JSON = JSON.stringify({
  name: "Cartão de pedido",
  description: "Pedido com status e valor.",
  fields: { titulo: { type: "text", required: true }, valor: { type: "number", role: "highlight" } },
});

const WIDGET_HTML = '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-field name="valor"></ravi-field></ravi-card>\n';

const ERROR_DIAGNOSTIC = {
  severity: "error",
  code: "WIDGET_FIELD_UNKNOWN",
  message: "Unknown field {total}.",
  file: "widget.html",
  line: 2,
  column: 14,
};

let stateDir: string | null = null;
let workDir: string;
let fake: FakeConsole;
let fetchSpy: ReturnType<typeof spyOn> | null = null;
let checkAnswer: () => Response;
let previewAnswer: () => Response;

const routes: FakeRoute = ({ method, rest }) => {
  if (method === "POST" && rest.length === 1 && rest[0] === "check") return checkAnswer();
  if (method === "POST" && rest.length === 1 && rest[0] === "preview") return previewAnswer();
  if (method === "POST" && rest.length === 1 && rest[0] === "scaffold") {
    return json(200, {
      files: [
        { path: "widget.html", content: WIDGET_HTML },
        { path: "widget.json", content: WIDGET_JSON },
        { path: "example.json", content: '{ "titulo": "Pedido 1", "valor": 10 }\n' },
      ],
      diagnostics: [],
    });
  }
  if (method === "GET" && rest.length === 1 && rest[0] === "catalog") {
    return json(200, {
      text: "# Widgets\n\n- org/pedido-card: Pedido com status e valor.\n",
      widgets: [
        {
          ref: "org/pedido-card",
          name: "Cartão de pedido",
          description: "Pedido com status e valor.",
          fields: { titulo: { type: "text", required: true } },
          variants: ["default", "compact"],
        },
      ],
    });
  }
  return null;
};

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("widgets-cli-");
  workDir = mkdtempSync(join(tmpdir(), "widgets-cli-work-"));
  checkAnswer = () =>
    json(200, {
      ok: true,
      diagnostics: [],
      compiled: {
        name: "Cartão de pedido",
        description: "Pedido com status e valor.",
        fields: { titulo: { type: "text", required: true } },
        variants: { default: {}, compact: {} },
        actions: [],
        hash: "h",
      },
    });
  previewAnswer = () => json(200, { html: "<!doctype html><title>Preview</title>", diagnostics: [] });
  fake = createFakeConsole([], [], { kind: "widget", routes });
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

async function contractError(run: () => unknown): Promise<{ error: ContractError; err: string[] }> {
  let thrown: unknown;
  const captured = await capture(async () => {
    try {
      await run();
    } catch (error) {
      thrown = error;
    }
  });
  expect(thrown).toBeInstanceOf(ContractError);
  return { error: thrown as ContractError, err: captured.err };
}

function libraryRequests(): string[] {
  return fake.requests
    .filter((request) => request.path.startsWith("/api/cli/library/"))
    .map((request) => `${request.method} ${request.path.split("?")[0]}`);
}

function widgetDir(name = "pedido-card"): string {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "widget.html"), WIDGET_HTML);
  writeFileSync(join(dir, "widget.json"), WIDGET_JSON);
  return dir;
}

const operator = <T>(run: () => T) => runWithContext({}, run);
const agent = <T>(run: () => T) => runWithContext({ transport: "tool", agentId: "designer" }, run);

describe("widgets init", () => {
  it("writes the Console scaffold from a view and refuses to overwrite without --force (exit 3)", async () => {
    login();
    const dir = join(workDir, "pedido-card");
    const first = await capture(() =>
      operator(() => new WidgetsCommands().init(dir, undefined, VIEW_ID, undefined, false, true)),
    );
    expect(first.result).toMatchObject({ success: true, kind: "widget", slug: "pedido-card" });
    expect(first.result.files.map((file) => file.file)).toEqual(["widget.html", "widget.json", "example.json"]);
    const scaffold = fake.requests.find((request) => request.path.startsWith("/api/cli/library/widgets/scaffold"));
    expect(scaffold?.body).toMatchObject({ slug: "pedido-card", view: VIEW_ID });
    expect(readFileSync(join(dir, "widget.html"), "utf8")).toBe(WIDGET_HTML);

    writeFileSync(join(dir, "widget.html"), "<p>meu</p>");
    const { error } = await contractError(() =>
      operator(() => new WidgetsCommands().init(dir, undefined, undefined, undefined, false, true)),
    );
    expect(error).toMatchObject({ code: "LIBRARY_FILES_EXIST", exitCode: 3 });
    expect(readFileSync(join(dir, "widget.html"), "utf8")).toBe("<p>meu</p>");

    await capture(() => operator(() => new WidgetsCommands().init(dir, undefined, undefined, undefined, true, true)));
    expect(readFileSync(join(dir, "widget.html"), "utf8")).toBe(WIDGET_HTML);
  });

  it("refuses a view id that is not a uuid and a reserved slug (exit 2) before any request", async () => {
    login();
    const badView = await contractError(() =>
      operator(() => new WidgetsCommands().init(join(workDir, "card"), undefined, "vendas", undefined, false, true)),
    );
    expect(badView.error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    const reserved = await contractError(() =>
      operator(() =>
        new WidgetsCommands().init(join(workDir, "catalog"), undefined, undefined, undefined, false, true),
      ),
    );
    expect(reserved.error).toMatchObject({ code: "LIBRARY_SLUG_RESERVED", exitCode: 2 });
    expect(libraryRequests()).toEqual([]);
  });

  it("never writes through a symlink, dangling or not, even with --force (exit 3)", async () => {
    login();
    const dir = join(workDir, "pedido-card");
    mkdirSync(dir);
    const outside = join(workDir, "fora.html");
    symlinkSync(outside, join(dir, "widget.html"));
    for (const force of [false, true]) {
      const { error } = await contractError(() =>
        operator(() => new WidgetsCommands().init(dir, undefined, undefined, undefined, force, true)),
      );
      expect(error).toMatchObject({ code: "LIBRARY_FILES_EXIST", exitCode: 3 });
      expect(error.message).toBe("widget.html exists and is not a regular file.");
    }
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(dir, "widget.json"))).toBe(false);
  });
});

describe("widgets show", () => {
  it("refuses a reserved route word as a slug (exit 2) before any request", async () => {
    login();
    for (const word of ["catalog", "check", "preview", "scaffold", "proposals", "none"]) {
      const { error } = await contractError(() =>
        operator(() => new WidgetsCommands().show(word, undefined, undefined, true)),
      );
      expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    }
    const catalog = await contractError(() =>
      operator(() => new WidgetsCommands().show("catalog", undefined, undefined, true)),
    );
    expect(catalog.error.details.suggestedAction).toBe("Use: ravi widgets catalog");
    expect(libraryRequests()).toEqual([]);
  });
});

describe("widgets check", () => {
  it("summarizes the compiled widget", async () => {
    login();
    const { result, out } = await capture(() => operator(() => new WidgetsCommands().check(widgetDir())));
    expect(result).toMatchObject({ kind: "widget", ok: true, widget: { name: "Cartão de pedido" } });
    expect(result.widget?.variants).toEqual(["default", "compact"]);
    expect(out.join("\n")).toContain("Fields: titulo:text!");
  });

  it("prints file:line:column diagnostics and exits 2 with WIDGET_INVALID", async () => {
    login();
    checkAnswer = () => json(200, { ok: false, diagnostics: [ERROR_DIAGNOSTIC], compiled: null });
    const { error, err } = await contractError(() => operator(() => new WidgetsCommands().check(widgetDir())));
    expect(error).toMatchObject({ code: "WIDGET_INVALID", exitCode: 2 });
    expect(err[0]).toBe("widget.html:2:14 error WIDGET_FIELD_UNKNOWN Unknown field {total}.");
    expect(error.details.issues).toContainEqual({
      path: ["widget.html", 2, 14],
      code: "WIDGET_FIELD_UNKNOWN",
      message: "Unknown field {total}.",
      severity: "error",
    });
  });

  it("reads and sends only the files the widget kind allows", async () => {
    login();
    const dir = widgetDir();
    writeFileSync(join(dir, "script.js"), "alert(1)");
    const checked = await capture(() => operator(() => new WidgetsCommands().check(dir, true)));
    // Files outside the allow-list are not read or sent.
    expect(checked.result.files.map((file) => file.file)).toEqual(["widget.html", "widget.json"]);
    const sent = fake.requests.find((request) => request.path === "/api/cli/library/widgets/check");
    const body = sent?.body as { files: Array<{ path: string }> } | undefined;
    expect(body?.files.map((file) => file.path)).toEqual(["widget.html", "widget.json"]);
  });
});

describe("widgets preview", () => {
  it("writes <dir>/preview.html by default and sends theme none and --data", async () => {
    login();
    const dir = widgetDir();
    const dataFile = join(workDir, "pedido.json");
    writeFileSync(dataFile, JSON.stringify({ titulo: "Pedido 7", valor: 70 }));
    const { result } = await capture(() =>
      operator(() => new WidgetsCommands().preview(dir, dataFile, "none", undefined, true)),
    );
    expect(result).toMatchObject({ success: true, out: join(dir, "preview.html"), diagnostics: [] });
    expect(readFileSync(join(dir, "preview.html"), "utf8")).toBe("<!doctype html><title>Preview</title>");
    const sent = fake.requests.find((request) => request.path.startsWith("/api/cli/library/widgets/preview"));
    expect(sent?.body).toMatchObject({ theme: "none", data: { titulo: "Pedido 7", valor: 70 } });
  });

  it("writes nothing and exits 2 when the preview has errors", async () => {
    login();
    previewAnswer = () => json(200, { html: "", diagnostics: [ERROR_DIAGNOSTIC] });
    const dir = widgetDir();
    const out = join(workDir, "fora.html");
    const { error, err } = await contractError(() =>
      operator(() => new WidgetsCommands().preview(dir, undefined, undefined, out, false)),
    );
    expect(error).toMatchObject({ code: "WIDGET_INVALID", exitCode: 2 });
    expect(err[0]).toBe("widget.html:2:14 error WIDGET_FIELD_UNKNOWN Unknown field {total}.");
    expect(existsSync(out)).toBe(false);
  });

  it("refuses --data that is not a JSON file (exit 2) before any request", async () => {
    login();
    const { error } = await contractError(() =>
      operator(() =>
        new WidgetsCommands().preview(widgetDir(), join(workDir, "nada.json"), undefined, undefined, true),
      ),
    );
    expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2 });
    expect(libraryRequests()).toEqual([]);
  });
});

describe("widgets catalog", () => {
  it("prints the Console's text, and the widgets with --json", async () => {
    login();
    const text = await capture(() => operator(() => new WidgetsCommands().catalog()));
    expect(text.out).toEqual(["# Widgets\n\n- org/pedido-card: Pedido com status e valor."]);
    const asJson = await capture(() => operator(() => new WidgetsCommands().catalog(undefined, true)));
    expect(asJson.result.widgets).toEqual([
      {
        ref: "org/pedido-card",
        name: "Cartão de pedido",
        description: "Pedido com status e valor.",
        fields: { titulo: { type: "text", role: null, required: true, label: null, description: null } },
        variants: ["default", "compact"],
      },
    ]);
  });
});

describe("widgets publish and propose", () => {
  it("dry-runs publish with the plan (exit 3) after the check", async () => {
    login();
    const { error } = await contractError(() =>
      operator(() => new WidgetsCommands().publish(widgetDir(), "org", undefined, undefined, undefined, true, false)),
    );
    expect(error).toMatchObject({ code: "WRITE_REQUIRES_EXECUTE", exitCode: 3 });
    expect(error.details.plan).toMatchObject({ ref: "org/pedido-card", kind: "widget", nextVersion: 1 });
    expect(libraryRequests()).toContain("POST /api/cli/library/widgets/check");
    expect(libraryRequests()).not.toContain("POST /api/cli/library/widgets");
  });

  it("refuses publish inside an agent turn (exit 3) and points to propose", async () => {
    login();
    const { error } = await contractError(() =>
      agent(() => new WidgetsCommands().publish(widgetDir(), "org", undefined, undefined, undefined, true, true)),
    );
    expect(error).toMatchObject({ code: "LIBRARY_AGENT_CANNOT_PUBLISH", exitCode: 3 });
    expect(String(error.details.suggestedAction)).toBe("ravi widgets propose <dir> --scope org --execute");
    expect(libraryRequests()).toEqual([]);
  });

  it("lets the operator propose with --execute, name and description from widget.json", async () => {
    login();
    const { result } = await capture(() =>
      operator(() =>
        new WidgetsCommands().propose(
          widgetDir(),
          "org",
          undefined,
          undefined,
          "primeira versão",
          undefined,
          undefined,
          undefined,
          true,
          true,
        ),
      ),
    );
    expect(result).toMatchObject({ success: true, ref: "org/pedido-card", number: 1 });
    const post = fake.requests.find((request) => request.path === "/api/cli/library/widgets/proposals");
    expect(post?.body).toMatchObject({
      scope: "org",
      slug: "pedido-card",
      name: "Cartão de pedido",
      description: "Pedido com status e valor.",
      submit: true,
    });
  });
});

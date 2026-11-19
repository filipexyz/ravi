import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextRecord } from "../router/router-db.js";
import {
  RaviAppCompositionError,
  appCallerOf,
  assertOperationProvided,
  composedContextAllow,
  declaresProvides,
  declaresRequires,
  describeUnavailableDependency,
  isExactVersion,
  isVersionRange,
  participatesInComposition,
  parseServiceKey,
  providedServices,
  requiredServices,
  resolveDependencyClosure,
  satisfiesRange,
  validateComposition,
} from "./composition.js";
import { checkAppManifests, discoverAppManifests } from "./service.js";
import type { RaviAppManifest, RaviAppManifestRecord } from "./types.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.RAVI_STATE_DIR;

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-apps-composition-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "apps"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  process.env.RAVI_STATE_DIR = join(root, ".state");
  process.chdir(root);
  return root;
}

function writeApp(root: string, body: Record<string, unknown>): void {
  const id = String(body.id);
  const dir = join(root, "src", "apps", ...id.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ravi.app.json"), JSON.stringify(body, null, 2));
}

/** A valid app with one read operation, `<id>.render`, and whatever composition the test adds. */
function appManifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const prefix = id.replace(/\//g, ".");
  return {
    schema: "ravi.app/v1",
    id,
    name: id,
    version: "1.0.0",
    description: `${id} fixture`,
    interfaces: { cli: { command: "bun cli.mjs", json: true } },
    context: { allow: [] },
    operations: {
      [`${prefix}.render`]: { interface: "cli", command: "bun cli.mjs render {args}", mutating: false },
    },
    permissions: { required: [], optional: [], mutating: [] },
    health: { checks: [] },
    ...extra,
  };
}

function provides(id: string, version = "1.0.0", operations = [`${id}.render`]): Record<string, unknown> {
  return { [`${id}/html`]: { version, operations } };
}

function records(): Map<string, RaviAppManifestRecord> {
  return new Map(
    discoverAppManifests()
      .filter((record) => record.manifest)
      .map((record) => [record.manifest!.id, record]),
  );
}

function errorsFor(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const operations = (manifest.operations ?? {}) as Record<string, unknown>;
  validateComposition(manifest as unknown as RaviAppManifest, new Set(Object.keys(operations)), errors);
  return errors;
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("service keys and versions", () => {
  it("splits a key into the providing app and the service, whatever the depth of the app id", () => {
    expect(parseServiceKey("md-render/html")).toEqual({ key: "md-render/html", appId: "md-render", service: "html" });
    expect(parseServiceKey("music/player/stream")).toEqual({
      key: "music/player/stream",
      appId: "music/player",
      service: "stream",
    });
    for (const bad of [
      "",
      "md-render",
      "Md/html",
      "md-render//html",
      "md-render/",
      "/html",
      "md_render/html",
      "1md/html",
    ]) {
      expect(parseServiceKey(bad)).toBeNull();
    }
  });

  it("accepts only an exact x.y.z as an offered version", () => {
    for (const good of ["0.0.0", "1.0.0", "10.20.30"]) expect(isExactVersion(good)).toBe(true);
    for (const bad of ["1", "1.0", "01.0.0", "1.0.0-beta", "1.0.0+build", "v1.0.0", "", " 1.0.0", 1, null]) {
      expect(isExactVersion(bad)).toBe(false);
    }
  });

  it("accepts only ranges it can read, because the parser that decides a match treats any text as match-all", () => {
    for (const good of ["^1", "~1.2", "^1.2.3", ">=1.2.0 <2", "1.4.0", "=1.0.0", ">1 <=3"]) {
      expect(isVersionRange(good)).toBe(true);
    }
    for (const bad of [
      "",
      " ^1",
      "^1 ",
      "^1  <2",
      "latest",
      "x",
      "*",
      "1.x",
      "^1.0.0-beta",
      ">=1 <2 <3 <4",
      "not a range",
    ]) {
      expect(isVersionRange(bad)).toBe(false);
      expect(satisfiesRange("1.0.0", bad)).toBe(false);
    }
    // Not text at all: never a range, whatever the number would read as.
    for (const notText of [1, null, undefined, {}, ["^1"]]) expect(isVersionRange(notText)).toBe(false);
  });

  it("decides satisfaction like semver does", () => {
    expect(satisfiesRange("1.2.0", "^1")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1")).toBe(false);
    expect(satisfiesRange("0.2.5", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesRange("1.0.9", "~1.0.0")).toBe(true);
    expect(satisfiesRange("1.1.0", "~1.0.0")).toBe(false);
    expect(satisfiesRange("1.5.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfiesRange("1.10.0", ">=1.9.0 <1.11.0")).toBe(true);
    expect(satisfiesRange("1.2.0", "1.2.0")).toBe(true);
    expect(satisfiesRange("1.2.1", "1.2.0")).toBe(false);
    // An offered version that is not exact never satisfies anything.
    expect(satisfiesRange("1.2", "^1")).toBe(false);
  });
});

describe("manifest validation", () => {
  it("accepts a well-formed provides and requires", () => {
    const manifest = appManifest("md-render", { provides: provides("md-render"), requires: { "other/svc": "^2" } });
    expect(errorsFor(manifest)).toEqual([]);
    expect(declaresProvides(manifest as unknown as RaviAppManifest)).toBe(true);
    expect(declaresRequires(manifest as unknown as RaviAppManifest)).toBe(true);
    expect(participatesInComposition(appManifest("plain") as unknown as RaviAppManifest)).toBe(false);
  });

  it("rejects a provides that is malformed", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ provides: [] }, "provides must be an object keyed by <app-id>/<service>."],
      [
        { provides: { "other/html": { version: "1.0.0", operations: ["md-render.render"] } } },
        'the key must be "md-render/<service>"',
      ],
      [{ provides: { "md-render/Html": { version: "1.0.0", operations: ["md-render.render"] } } }, "the key must be"],
      [{ provides: { "md-render/html": "1.0.0" } }, "must be an object with version and operations."],
      [{ provides: provides("md-render", "^1.0.0") }, "version must be an exact x.y.z version."],
      [{ provides: provides("md-render", "1.0.0", []) }, "operations must be a non-empty array of operation ids."],
      [
        { provides: provides("md-render", "1.0.0", ["md-render.missing"]) },
        "operations[0] is not declared in operations.",
      ],
      [
        { provides: provides("md-render", "1.0.0", ["md-render.render", "md-render.render"]) },
        "operations[1] duplicates another offered operation.",
      ],
    ];
    for (const [extra, expected] of cases) {
      expect(errorsFor(appManifest("md-render", extra)).join("\n")).toContain(expected);
    }
  });

  it("does not let an app offer its permission provider operation", () => {
    const manifest = appManifest("md-render", {
      provides: provides("md-render", "1.0.0", ["md-render.decide"]),
      permissions: { required: [], optional: [], mutating: [], provider: { operation: "md-render.decide" } },
      operations: {
        "md-render.render": { interface: "cli", command: "bun cli.mjs render {args}", mutating: false },
        "md-render.decide": { interface: "cli", command: "bun cli.mjs decide", mutating: false },
      },
    });
    expect(errorsFor(manifest).join("\n")).toContain("is the permission provider operation and cannot be offered.");
  });

  it("rejects a requires that is malformed or that points at the app itself", () => {
    const cases: Array<[unknown, string]> = [
      [[], "requires must be an object mapping <app-id>/<service> to a version range."],
      [{ "md-render": "^1" }, 'the key must be "<app-id>/<service>"'],
      [{ "md-render/html": "latest" }, "must be a version range such as ^1 or >=1.2.0 <2.0.0."],
      [{ "md-render/html": 1 }, "must be a version range"],
      [{ "blog/html": "^1" }, "an app cannot require its own service."],
    ];
    for (const [requires, expected] of cases) {
      expect(errorsFor(appManifest("blog", { requires })).join("\n")).toContain(expected);
    }
  });

  it("reports the errors through discovery, and an app with them is not valid", () => {
    const root = makeRepo();
    writeApp(root, appManifest("md-render", { provides: provides("md-render", "latest") }));
    const check = checkAppManifests("md-render").find((entry) => entry.id === "md-render");
    expect(check?.ok).toBe(false);
    expect(check?.errors.join("\n")).toContain("version must be an exact x.y.z version.");
  });
});

describe("a circle of requires", () => {
  it("makes every app on the circle invalid and names the path", () => {
    const root = makeRepo();
    writeApp(root, appManifest("alpha", { provides: provides("alpha"), requires: { "beta/html": "^1" } }));
    writeApp(root, appManifest("beta", { provides: provides("beta"), requires: { "alpha/html": "^1" } }));
    const found = records();
    expect(found.get("alpha")?.valid).toBe(false);
    expect(found.get("beta")?.valid).toBe(false);
    expect(found.get("alpha")?.errors).toContain("requires cycle: alpha -> beta -> alpha.");
    expect(found.get("beta")?.errors).toContain("requires cycle: beta -> alpha -> beta.");
  });

  it("finds a longer circle, and leaves an app that only leads into it valid", () => {
    const root = makeRepo();
    writeApp(root, appManifest("one", { provides: provides("one"), requires: { "two/html": "^1" } }));
    writeApp(root, appManifest("two", { provides: provides("two"), requires: { "three/html": "^1" } }));
    writeApp(root, appManifest("three", { provides: provides("three"), requires: { "one/html": "^1" } }));
    writeApp(root, appManifest("entry", { requires: { "one/html": "^1" } }));
    const found = records();
    expect(found.get("one")?.errors).toContain("requires cycle: one -> two -> three -> one.");
    for (const id of ["one", "two", "three"]) expect(found.get(id)?.valid).toBe(false);
    expect(found.get("entry")?.valid).toBe(true);
    // What `entry` needs is invalid, so it is told as a warning, and the router will refuse to run it.
    expect(found.get("entry")?.warnings.join("\n")).toContain(
      "entry requires one/html@^1: the provider's manifest is invalid or ambiguous.",
    );
  });

  it("reports an app that requires itself once, as a validation error and not as a circle", () => {
    const root = makeRepo();
    writeApp(root, appManifest("solo", { provides: provides("solo"), requires: { "solo/html": "^1" } }));
    const solo = records().get("solo");
    expect(solo?.valid).toBe(false);
    expect(solo?.errors.filter((error) => error.includes("cannot require its own service"))).toHaveLength(1);
    expect(solo?.errors.some((error) => error.includes("requires cycle"))).toBe(false);
  });

  it("does not flag a chain that does not close", () => {
    const root = makeRepo();
    writeApp(root, appManifest("top", { requires: { "mid/html": "^1" } }));
    writeApp(root, appManifest("mid", { provides: provides("mid"), requires: { "base/html": "^1" } }));
    writeApp(root, appManifest("base", { provides: provides("base") }));
    const found = records();
    for (const id of ["top", "mid", "base"]) {
      expect(found.get(id)?.valid).toBe(true);
      expect(found.get(id)?.warnings.some((warning) => warning.includes("requires"))).toBe(false);
    }
  });
});

describe("a provider that is not there", () => {
  it("is a warning on the consumer, which clears when the provider comes back", () => {
    const root = makeRepo();
    writeApp(root, appManifest("blog", { requires: { "md-render/html": "^1" } }));
    const missing = records().get("blog");
    expect(missing?.valid).toBe(true);
    expect(missing?.warnings).toContain("blog requires md-render/html@^1: no app with that id is installed.");

    writeApp(root, appManifest("md-render", { provides: provides("md-render", "1.2.0") }));
    expect(
      records()
        .get("blog")
        ?.warnings.some((warning) => warning.includes("requires")),
    ).toBe(false);

    writeApp(root, appManifest("md-render", { provides: provides("md-render", "2.0.0") }));
    expect(records().get("blog")?.warnings).toContain("blog requires md-render/html@^1: the provider offers 2.0.0.");

    writeApp(root, appManifest("md-render"));
    expect(records().get("blog")?.warnings).toContain(
      "blog requires md-render/html@^1: the provider does not offer that service.",
    );
  });

  it("is told in the structured form the router returns", () => {
    expect(
      describeUnavailableDependency({
        requires: "md-render/html",
        range: "^1",
        requiredBy: "blog",
        reason: "version_mismatch",
        installedVersion: "2.0.0",
      }),
    ).toBe("blog requires md-render/html@^1: the provider offers 2.0.0.");
  });
});

describe("what a composed app may ask for", () => {
  function setup(root: string): Map<string, RaviAppManifestRecord> {
    writeApp(root, appManifest("top", { context: { allow: ["read:context:whoami"] }, requires: { "mid/html": "^1" } }));
    writeApp(
      root,
      appManifest("mid", {
        context: { allow: ["execute:group:pages"] },
        provides: provides("mid"),
        requires: { "base/html": "^1" },
      }),
    );
    writeApp(
      root,
      appManifest("base", {
        context: { allow: ["read:bases:show"] },
        provides: provides("base", "1.0.0", ["base.write"]),
        operations: {
          "base.write": {
            interface: "cli",
            command: "bun cli.mjs write {args}",
            mutating: true,
            permission: "base:write",
          },
        },
        permissions: { required: [], optional: [], mutating: ["base:write"] },
      }),
    );
    return records();
  }

  it("follows requires through the providers, once each", () => {
    const found = setup(makeRepo());
    const closure = resolveDependencyClosure(found.get("top")!, [...found.values()]);
    expect(closure.unavailable).toEqual([]);
    expect(closure.providers.map((provider) => provider.manifest?.id)).toEqual(["mid", "base"]);
    expect(closure.edges.map((edge) => `${edge.requiredBy.manifest?.id}>${edge.provider.manifest?.id}`)).toEqual([
      "top>mid",
      "mid>base",
    ]);
  });

  it("is the union of every allow in the chain, plus the right to call each provider", () => {
    const found = setup(makeRepo());
    const top = found.get("top")!;
    const allow = composedContextAllow(top, resolveDependencyClosure(top, [...found.values()]));
    expect(allow.sort()).toEqual(
      [
        "read:context:whoami",
        "execute:group:pages",
        "read:bases:show",
        "use:app:mid",
        "use:app:base",
        // `base` offers a mutating operation, so calling it takes `execute`, which the run will need.
        "execute:app:base",
      ].sort(),
    );
    // `mid` offers only a read operation: no execute on it.
    expect(allow).not.toContain("execute:app:mid");
  });

  it("reports every missing provider in the chain with who required it", () => {
    const root = makeRepo();
    writeApp(root, appManifest("top", { requires: { "mid/html": "^1" } }));
    writeApp(root, appManifest("mid", { provides: provides("mid"), requires: { "base/html": "^1" } }));
    const found = records();
    const closure = resolveDependencyClosure(found.get("top")!, [...found.values()]);
    expect(closure.unavailable).toEqual([
      { requires: "base/html", range: "^1", requiredBy: "mid", reason: "not_installed" },
    ]);
  });

  it("keeps an app that composes nothing exactly as it was", () => {
    const root = makeRepo();
    writeApp(root, appManifest("plain", { context: { allow: ["read:context:whoami"] } }));
    const found = records();
    const plain = found.get("plain")!;
    const closure = resolveDependencyClosure(plain, [...found.values()]);
    expect(closure).toEqual({ providers: [], edges: [], unavailable: [] });
    expect(composedContextAllow(plain, closure)).toEqual(["read:context:whoami"]);
  });
});

describe("calls from one app to another", () => {
  function context(overrides: Partial<ContextRecord>): ContextRecord {
    return {
      contextId: "ctx_probe",
      contextKey: "rctx_probe",
      kind: "app-runtime",
      capabilities: [],
      metadata: { appId: "blog", source: "app-router" },
      createdAt: 0,
      ...overrides,
    };
  }

  it("names the app only for a context the app router issued for an app", () => {
    expect(appCallerOf(context({}))).toBe("blog");
    expect(appCallerOf(undefined)).toBeNull();
    expect(appCallerOf(context({ kind: "turn-runtime" }))).toBeNull();
    expect(appCallerOf(context({ metadata: { appId: "blog" } }))).toBeNull();
    expect(appCallerOf(context({ metadata: { source: "app-router" } }))).toBeNull();
    expect(appCallerOf(context({ metadata: { appId: 7, source: "app-router" } }))).toBeNull();
  });

  function setup(root: string): RaviAppManifestRecord[] {
    writeApp(
      root,
      appManifest("md-render", {
        provides: provides("md-render", "1.2.0"),
        operations: {
          "md-render.render": { interface: "cli", command: "bun cli.mjs render {args}", mutating: false },
          "md-render.admin": { interface: "cli", command: "bun cli.mjs admin {args}", mutating: false },
        },
      }),
    );
    writeApp(root, appManifest("blog", { requires: { "md-render/html": "^1" } }));
    writeApp(root, appManifest("stranger"));
    return [...records().values()];
  }

  it("lets a declared requirement call an operation the service lists", () => {
    const all = setup(makeRepo());
    const callee = all.find((record) => record.manifest?.id === "md-render")!;
    expect(assertOperationProvided(callee, "md-render.render", "blog", all)).toEqual({ service: "md-render/html" });
  });

  it("refuses an operation the provider has but does not list", () => {
    const all = setup(makeRepo());
    const callee = all.find((record) => record.manifest?.id === "md-render")!;
    expect(() => assertOperationProvided(callee, "md-render.admin", "blog", all)).toThrow(RaviAppCompositionError);
    try {
      assertOperationProvided(callee, "md-render.admin", "blog", all);
    } catch (error) {
      expect((error as RaviAppCompositionError).code).toBe("APP_OPERATION_NOT_PROVIDED");
    }
  });

  it("refuses a caller that did not declare the requirement, or that is not installed", () => {
    const all = setup(makeRepo());
    const callee = all.find((record) => record.manifest?.id === "md-render")!;
    expect(() => assertOperationProvided(callee, "md-render.render", "stranger", all)).toThrow(RaviAppCompositionError);
    expect(() => assertOperationProvided(callee, "md-render.render", "ghost", all)).toThrow(RaviAppCompositionError);
  });

  it("refuses when the provider's version no longer satisfies the range the caller declared", () => {
    const root = makeRepo();
    const all = setup(root);
    writeApp(root, appManifest("blog", { requires: { "md-render/html": "^2" } }));
    const after = [...records().values()];
    const callee = after.find((record) => record.manifest?.id === "md-render")!;
    expect(all.length).toBeGreaterThan(0);
    expect(() => assertOperationProvided(callee, "md-render.render", "blog", after)).toThrow(RaviAppCompositionError);
  });

  it("reads only the well-formed entries, so a broken manifest never throws", () => {
    const broken = {
      provides: { "x/y": 1, bad: { version: "1.0.0", operations: [] }, "m/n": { version: "1", operations: [] } },
      requires: { z: 1 },
    };
    expect(providedServices(broken as unknown as RaviAppManifest)).toEqual({});
    expect(requiredServices(broken as unknown as RaviAppManifest)).toEqual([]);
    expect(providedServices(null)).toEqual({});
    expect(requiredServices(undefined)).toEqual([]);
  });
});

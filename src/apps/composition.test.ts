import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextRecord } from "../router/router-db.js";
import {
  RaviAppCompositionError,
  assertOperationProvided,
  callerOf,
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

  it("says the provider is broken, not missing, when its manifest does not parse", () => {
    const root = makeRepo();
    writeApp(root, appManifest("blog", { requires: { "md-render/html": "^1" } }));
    mkdirSync(join(root, "src", "apps", "md-render"), { recursive: true });
    writeFileSync(join(root, "src", "apps", "md-render", "ravi.app.json"), '{ "schema": "ravi.app/v1", "id": "md-r');

    const found = records();
    expect(discoverAppManifests().find((record) => record.id === "md-render")?.valid).toBe(false);
    const blog = found.get("blog");
    expect(blog?.warnings).toContain(
      "blog requires md-render/html@^1: the provider's manifest is invalid or ambiguous.",
    );
    expect(blog?.warnings.join("\n")).not.toContain("no app with that id is installed");
    const closure = resolveDependencyClosure(blog as RaviAppManifestRecord, discoverAppManifests());
    expect(closure.unavailable).toEqual([
      { requires: "md-render/html", range: "^1", requiredBy: "blog", reason: "invalid" },
    ]);
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

describe("discovery filtered by source", () => {
  /** A repo app and a state app: the two sources every test machine has. */
  function writeStateApp(body: Record<string, unknown>): void {
    const id = String(body.id);
    const dir = join(process.env.RAVI_STATE_DIR as string, "apps", ...id.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ravi.app.json"), JSON.stringify(body, null, 2));
  }

  it("satisfies a requirement with a provider from another source", () => {
    const root = makeRepo();
    writeApp(root, appManifest("md-render", { provides: provides("md-render") }));
    writeStateApp(appManifest("blog", { requires: { "md-render/html": "^1" } }));

    for (const source of [undefined, "state", "repo"] as const) {
      const blog = discoverAppManifests({ source }).find((record) => record.manifest?.id === "blog");
      if (source === "repo") {
        expect(blog).toBeUndefined();
        continue;
      }
      expect(blog?.source).toBe("state");
      expect(blog?.warnings.some((warning) => warning.includes("requires"))).toBe(false);
    }
  });

  it("finds a circle that runs through two sources, in either view", () => {
    const root = makeRepo();
    writeApp(root, appManifest("alpha", { provides: provides("alpha"), requires: { "beta/html": "^1" } }));
    writeStateApp(appManifest("beta", { provides: provides("beta"), requires: { "alpha/html": "^1" } }));

    for (const source of [undefined, "repo", "state"] as const) {
      const found = discoverAppManifests({ source });
      expect(found.length).toBe(source ? 1 : 2);
      for (const record of found) {
        expect(record.valid).toBe(false);
        expect(record.errors.some((error) => error.startsWith("requires cycle:"))).toBe(true);
      }
    }
  });
});

describe("discovery when the roots overlap", () => {
  it("still lists an app that sits under both the repo root and the state root, in every view", () => {
    const root = makeRepo();
    // A state directory inside the repository makes `<repo>/src/apps` the repo root and the state root at once.
    process.env.RAVI_STATE_DIR = join(realpathSync(root), "src");
    writeApp(root, appManifest("plain"));

    for (const source of [undefined, "repo", "state"] as const) {
      const shown = discoverAppManifests({ source });
      expect(shown.map((record) => record.manifest?.id)).toEqual(["plain"]);
      expect(shown[0]?.valid).toBe(true);
      // The file belongs to the source the listing asks for, as it did before composition read every source.
      if (source) expect(shown[0]?.source).toBe(source);
    }
  });
});

describe("duplicate ids across sources", () => {
  it("are flagged the same way whichever source a listing shows", () => {
    const root = makeRepo();
    writeApp(root, appManifest("md-render", { provides: provides("md-render") }));
    const stateDir = join(process.env.RAVI_STATE_DIR as string, "apps", "md-render");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "ravi.app.json"), JSON.stringify(appManifest("md-render"), null, 2));

    const everything = discoverAppManifests();
    expect(everything.filter((record) => !record.valid)).toHaveLength(1);
    const flagged = everything.find((record) => !record.valid);
    expect(flagged?.errors.join("\n")).toContain('Duplicate app id "md-render"');
    for (const source of ["repo", "state"] as const) {
      const shown = discoverAppManifests({ source });
      expect(shown).toHaveLength(1);
      // The record is the same one, with the same verdict, as in the listing of every source.
      expect(shown[0]?.valid).toBe(shown[0]?.path === flagged?.path ? false : true);
    }
  });
});

describe("what a composed app may ask for", () => {
  function setup(root: string): Map<string, RaviAppManifestRecord> {
    // Each app declares what the apps it requires declare, because it delegates that to them.
    writeApp(
      root,
      appManifest("top", {
        context: { allow: ["read:context:whoami", "execute:group:pages", "read:bases:show"] },
        requires: { "mid/html": "^1" },
      }),
    );
    writeApp(
      root,
      appManifest("mid", {
        context: { allow: ["execute:group:pages", "read:bases:show"] },
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

  it("is the app's own allow plus the right to call each provider, and nothing a provider declares", () => {
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

    // The same chain with a top that declares less: the ceiling is its own declaration, so a provider's allow does not
    // top it up. The chain is refused instead (below).
    const narrow = found.get("mid")!;
    expect(composedContextAllow(narrow, resolveDependencyClosure(narrow, [...found.values()])).sort()).toEqual(
      ["execute:group:pages", "read:bases:show", "use:app:base", "execute:app:base"].sort(),
    );
  });

  it("refuses a provider that asks for more than the app requiring it declares, and says what", () => {
    const root = makeRepo();
    writeApp(
      root,
      appManifest("blog", { context: { allow: ["read:context:whoami"] }, requires: { "md-render/html": "^1" } }),
    );
    writeApp(
      root,
      appManifest("md-render", {
        context: { allow: ["execute:group:pages", "read:context:whoami", "read:bases:show"] },
        provides: provides("md-render"),
      }),
    );
    const found = records();
    const blog = found.get("blog")!;
    const closure = resolveDependencyClosure(blog, [...found.values()]);
    expect(closure.providers).toEqual([]);
    expect(closure.unavailable).toEqual([
      {
        requires: "md-render/html",
        range: "^1",
        requiredBy: "blog",
        reason: "insufficient_authority",
        missing: ["execute:group:pages", "read:bases:show"],
      },
    ]);
    // The same gap is a warning at discovery, so `apps check` shows it before anything runs.
    expect(blog.warnings).toContain(
      "blog requires md-render/html@^1: the provider asks for execute:group:pages, read:bases:show which blog does not declare in context.allow.",
    );
    expect(blog.valid).toBe(true);
  });

  it("covers an entry only with the same entry, because context.allow is explicit", () => {
    const root = makeRepo();
    writeApp(
      root,
      appManifest("md-render", { context: { allow: ["execute:group:pages"] }, provides: provides("md-render") }),
    );
    writeApp(
      root,
      appManifest("blog", { context: { allow: ["execute:group:pages"] }, requires: { "md-render/html": "^1" } }),
    );
    const found = records();
    const blog = found.get("blog")!;
    expect(blog.valid).toBe(true);
    expect(resolveDependencyClosure(blog, [...found.values()]).unavailable).toEqual([]);
    expect(blog.warnings.filter((warning) => warning.includes("requires"))).toEqual([]);

    // A different entry does not stand in for it, and a wildcard is no way to say "everything": a manifest that tries
    // is invalid.
    writeApp(
      root,
      appManifest("blog", { context: { allow: ["execute:group:context"] }, requires: { "md-render/html": "^1" } }),
    );
    const other = records().get("blog")!;
    expect(other.valid).toBe(true);
    expect(other.warnings.join("\n")).toContain("which blog does not declare in context.allow");
    writeApp(
      root,
      appManifest("blog", { context: { allow: ["execute:group:*"] }, requires: { "md-render/html": "^1" } }),
    );
    expect(records().get("blog")?.valid).toBe(false);
  });

  it("turns back to normal when the requiring app declares what its provider asks, with no change to the provider", () => {
    const root = makeRepo();
    writeApp(
      root,
      appManifest("md-render", { context: { allow: ["execute:group:pages"] }, provides: provides("md-render") }),
    );
    writeApp(root, appManifest("blog", { requires: { "md-render/html": "^1" } }));
    expect(records().get("blog")?.warnings.join("\n")).toContain("execute:group:pages which blog does not declare");
    writeApp(
      root,
      appManifest("blog", { context: { allow: ["execute:group:pages"] }, requires: { "md-render/html": "^1" } }),
    );
    const declared = records().get("blog");
    expect(declared?.valid).toBe(true);
    expect(declared?.warnings.filter((warning) => warning.includes("requires"))).toEqual([]);
  });

  it("adds the public routing access to a consumer that has providers, and to nobody else", () => {
    const found = setup(makeRepo());
    const top = found.get("top")!;
    const closure = resolveDependencyClosure(top, [...found.values()]);
    expect(composedContextAllow(top, closure, "mutate:apps:run")).toContain("mutate:apps:run");
    expect(composedContextAllow(top, closure)).not.toContain("mutate:apps:run");
    // `base` has no providers of its own: nothing to route to, so nothing added.
    const base = found.get("base")!;
    expect(
      composedContextAllow(base, resolveDependencyClosure(base, [...found.values()]), "mutate:apps:run"),
    ).not.toContain("mutate:apps:run");
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
    expect(callerOf(context({}))).toEqual({ kind: "app", appId: "blog" });
    // No context at all is the operator's own terminal: nobody to mediate.
    expect(callerOf(undefined)).toEqual({ kind: "direct" });
    // A turn, or an agent: a root, with no app on the way.
    expect(callerOf(context({ kind: "turn-runtime", metadata: {} }))).toEqual({ kind: "direct" });
    // A context that claims to be an app's and does not name one is an app we cannot name, not a turn.
    expect(callerOf(context({ metadata: { appId: "blog" } }))).toEqual({ kind: "unknown" });
    expect(callerOf(context({ metadata: { source: "app-router" } }))).toEqual({ kind: "unknown" });
    expect(callerOf(context({ metadata: { appId: 7, source: "app-router" } }))).toEqual({ kind: "unknown" });
  });

  it("follows the lineage: a credential an app derived for itself is still the app's", () => {
    const app = context({ contextId: "ctx_app", metadata: { appId: "blog", source: "app-router" } });
    const derived = context({
      contextId: "ctx_derived",
      kind: "cli-runtime",
      metadata: { parentContextId: "ctx_app", issuedFor: "some-cli" },
    });
    const grandchild = context({
      contextId: "ctx_grand",
      kind: "cli-runtime",
      metadata: { parentContextId: "ctx_derived", issuedFor: "another-cli" },
    });
    const turn = context({ contextId: "ctx_turn", kind: "agent-runtime", metadata: {} });
    const known = new Map([app, derived, grandchild, turn].map((record) => [record.contextId, record]));
    const parentOf = (id: string) => known.get(id) ?? null;

    expect(callerOf(derived, parentOf)).toEqual({ kind: "app", appId: "blog" });
    expect(callerOf(grandchild, parentOf)).toEqual({ kind: "app", appId: "blog" });
    // Without a way to read the lineage, a context that has a parent cannot be placed.
    expect(callerOf(derived)).toEqual({ kind: "unknown" });
    // The nearest app wins: a provider's derived credential is the provider's.
    const provider = context({
      contextId: "ctx_provider",
      metadata: { appId: "md-render", source: "app-router", parentContextId: "ctx_app" },
    });
    const providerDerived = context({
      contextId: "ctx_provider_derived",
      kind: "cli-runtime",
      metadata: { parentContextId: "ctx_provider" },
    });
    known.set(provider.contextId, provider);
    expect(callerOf(providerDerived, parentOf)).toEqual({ kind: "app", appId: "md-render" });
    // A turn, and a credential derived from a turn, are not apps.
    expect(callerOf(turn, parentOf)).toEqual({ kind: "direct" });
    const fromTurn = context({
      contextId: "ctx_from_turn",
      kind: "cli-runtime",
      metadata: { parentContextId: "ctx_turn" },
    });
    expect(callerOf(fromTurn, parentOf)).toEqual({ kind: "direct" });
  });

  it("has no depth at which a chain of derived credentials stops being the app's", () => {
    const records = new Map<string, ContextRecord>();
    records.set("ctx_0", context({ contextId: "ctx_0", metadata: { appId: "blog", source: "app-router" } }));
    for (let depth = 1; depth <= 200; depth++) {
      records.set(
        `ctx_${depth}`,
        context({
          contextId: `ctx_${depth}`,
          kind: "cli-runtime",
          metadata: { parentContextId: `ctx_${depth - 1}`, issuedFor: "derived" },
        }),
      );
    }
    const parentOf = (id: string) => records.get(id) ?? null;
    for (const depth of [1, 15, 16, 17, 64, 200]) {
      expect(callerOf(records.get(`ctx_${depth}`), parentOf)).toEqual({ kind: "app", appId: "blog" });
    }
    // And the same chain on a turn is a turn at any depth.
    records.set("ctx_0", context({ contextId: "ctx_0", kind: "agent-runtime", metadata: {} }));
    expect(callerOf(records.get("ctx_200"), parentOf)).toEqual({ kind: "direct" });
  });

  it("is unknown, never direct, when the lineage cannot be followed to a root", () => {
    const loopA = context({ contextId: "ctx_a", kind: "cli-runtime", metadata: { parentContextId: "ctx_b" } });
    const loopB = context({ contextId: "ctx_b", kind: "cli-runtime", metadata: { parentContextId: "ctx_a" } });
    const known = new Map([loopA, loopB].map((record) => [record.contextId, record]));
    expect(callerOf(loopA, (id) => known.get(id))).toEqual({ kind: "unknown" });
    const orphan = context({
      contextId: "ctx_orphan",
      kind: "cli-runtime",
      metadata: { parentContextId: "ctx_missing" },
    });
    expect(callerOf(orphan, () => null)).toEqual({ kind: "unknown" });
    expect(callerOf(orphan, () => undefined)).toEqual({ kind: "unknown" });
    // A parent that is gone halfway up a chain that would have reached an app: still unknown.
    const child = context({ contextId: "ctx_child", kind: "cli-runtime", metadata: { parentContextId: "ctx_orphan" } });
    expect(callerOf(child, (id) => (id === "ctx_orphan" ? orphan : null))).toEqual({ kind: "unknown" });
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

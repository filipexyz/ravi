/**
 * Import boundary of the WhatsApp path (DESIGN-v2 D14, §12.3 item 1).
 *
 * (a) Nothing reachable through STATIC value imports from the WhatsApp/channel roots
 *     lives in `src/omni/**` or is `src/omni-config.ts`.
 * (b) Inside that closure, a dynamic `import()` into those targets appears only in
 *     `src/daemon-channels.ts`, `src/cli/commands/instances.ts` and `src/cli/media-send.ts`
 *     (the legacy-bridge branches).
 *
 * Edges: only relative specifiers count. `.js` resolves to `.ts`, then `/index.ts`, then
 * `.tsx`. A static clause that is type-only (`import type …`, or `{ … }` where every
 * specifier is `type X`) is skipped. Side-effect `import "x"` is a static edge, and so is a
 * `require("x")` call (it loads the module synchronously wherever it runs). Dynamic
 * `import("x")` edges are recorded but never followed. `src/cli/media-send-auth.ts` is not a
 * target (shared media failure catalog, no imports).
 *
 * Roots: every non-test `src/channels/**` file, the processes that serve or reach WhatsApp
 * (gateway, daemon, daemon-channels), the CLI entry `src/cli/index.ts` and the CLI modules
 * that send through WhatsApp.
 */

import { describe, expect, it } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

const STATIC_EDGE = /^\s*(import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gms;
const SIDE_EFFECT_EDGE = /^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC_EDGE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_EDGE = /\brequire\(\s*["']([^"']+)["']\s*\)/g;

const ROOT_FILES = [
  "src/gateway.ts",
  "src/daemon.ts",
  "src/daemon-channels.ts",
  "src/cli/index.ts",
  "src/cli/commands/group.ts",
  "src/cli/commands/instances.ts",
  "src/cli/commands/media.ts",
  "src/cli/commands/image.ts",
  "src/cli/commands/audio.ts",
  "src/cli/media-send.ts",
];

const DYNAMIC_OMNI_ALLOWED = new Set([
  "src/daemon-channels.ts",
  "src/cli/commands/instances.ts",
  "src/cli/media-send.ts",
]);

interface ParsedImports {
  /** Specifiers of static value edges (followed). */
  readonly static: string[];
  /** Specifiers of dynamic `import()` edges (recorded, never followed). */
  readonly dynamic: string[];
}

function isTypeOnlyClause(clause: string): boolean {
  if (/^type\s/.test(clause)) return true;
  const braces = clause.match(/^\{([\s\S]*)\}$/);
  if (!braces) return false;
  const specifiers = braces[1]!
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("type "));
}

function parseImports(source: string): ParsedImports {
  const staticSpecs: string[] = [];
  const dynamicSpecs: string[] = [];
  for (const match of source.matchAll(STATIC_EDGE)) {
    if (isTypeOnlyClause(match[2]!.trim())) continue;
    staticSpecs.push(match[3]!);
  }
  for (const match of source.matchAll(SIDE_EFFECT_EDGE)) staticSpecs.push(match[1]!);
  for (const match of source.matchAll(REQUIRE_EDGE)) staticSpecs.push(match[1]!);
  for (const match of source.matchAll(DYNAMIC_EDGE)) dynamicSpecs.push(match[1]!);
  return { static: staticSpecs, dynamic: dynamicSpecs };
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Resolve a relative specifier from `fromFile` (absolute). Non-relative or unresolvable → null. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const ts = base.replace(/\.js$/, ".ts");
  const stem = ts.replace(/\.ts$/, "");
  for (const candidate of [ts, `${stem}/index.ts`, `${stem}.tsx`, base]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

interface FileEdges {
  readonly static: string[];
  readonly dynamic: string[];
}

type EdgeReader = (file: string) => FileEdges;

function readEdges(file: string): FileEdges {
  const parsed = parseImports(readFileSync(file, "utf8"));
  const resolveAll = (specs: string[]) =>
    specs.map((spec) => resolveSpecifier(file, spec)).filter((path): path is string => path !== null);
  return { static: resolveAll(parsed.static), dynamic: resolveAll(parsed.dynamic) };
}

/** Breadth-first static closure; maps every reached file to the file that first reached it (roots → null). */
function staticClosure(roots: string[], edgesOf: EdgeReader): Map<string, string | null> {
  const parentOf = new Map<string, string | null>();
  const queue: string[] = [];
  for (const root of roots) {
    if (parentOf.has(root)) continue;
    parentOf.set(root, null);
    queue.push(root);
  }
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const next of edgesOf(file).static) {
      if (parentOf.has(next)) continue;
      parentOf.set(next, file);
      queue.push(next);
    }
  }
  return parentOf;
}

function chainTo(file: string, parentOf: Map<string, string | null>): string {
  const chain: string[] = [];
  let current: string | null | undefined = file;
  while (current) {
    chain.unshift(relative(REPO_ROOT, current));
    current = parentOf.get(current);
  }
  return chain.join(" -> ");
}

function isOmniTarget(absolutePath: string): boolean {
  const path = relative(REPO_ROOT, absolutePath).split("\\").join("/");
  return path.startsWith("src/omni/") || path === "src/omni-config.ts";
}

function rootFiles(): string[] {
  const channelFiles = [...new Glob("src/channels/**/*.ts").scanSync({ cwd: REPO_ROOT })]
    .map((path) => path.split("\\").join("/"))
    .filter((path) => !path.endsWith(".test.ts") && !path.split("/").includes("__tests__"));
  return [...channelFiles, ...ROOT_FILES].sort().map((path) => join(REPO_ROOT, path));
}

describe("import boundary parser", () => {
  it("skips type-only clauses and keeps value, re-export and side-effect edges", () => {
    const parsed = parseImports(
      [
        'import type { OmniClient } from "../omni/client.js";',
        'import { type A, type B } from "../omni/types.js";',
        "import {",
        "  type C,",
        "  value,",
        '} from "./mixed.js";',
        'export type { D } from "../omni/d.js";',
        'export * from "./reexport.js";',
        'import "./side-effect.js";',
        'const bridge = await import("../omni/legacy-bridge.js");',
        'const { slugify } = require("./session-name.js");',
        'const config = require.resolve("./not-loaded.js");',
      ].join("\n"),
    );

    expect(parsed.static).toEqual(["./mixed.js", "./reexport.js", "./side-effect.js", "./session-name.js"]);
    expect(parsed.dynamic).toEqual(["../omni/legacy-bridge.js"]);
  });

  it("follows require() edges like static imports", () => {
    const parsed = parseImports('const allCommands = require("./commands/index.js");');
    const graph: Record<string, FileEdges> = {
      root: { static: parsed.static, dynamic: [] },
      "./commands/index.js": { static: ["omni"], dynamic: [] },
      omni: { static: [], dynamic: [] },
    };
    const closure = staticClosure(["root"], (file) => graph[file]!);

    expect([...closure.keys()].sort()).toEqual(["./commands/index.js", "omni", "root"]);
  });

  it("records dynamic edges without following them", () => {
    const graph: Record<string, FileEdges> = {
      root: { static: ["a"], dynamic: ["lazy"] },
      a: { static: [], dynamic: [] },
      lazy: { static: ["omni"], dynamic: [] },
      omni: { static: [], dynamic: [] },
    };
    const closure = staticClosure(["root"], (file) => graph[file]!);

    expect([...closure.keys()].sort()).toEqual(["a", "root"]);
  });
});

describe("WhatsApp import boundary (D14)", () => {
  const roots = rootFiles();
  const parentOf = staticClosure(roots, readEdges);
  const reached = [...parentOf.keys()];

  it("follows real edges from the roots", () => {
    expect(roots.length).toBeGreaterThan(ROOT_FILES.length);
    expect(reached.length).toBeGreaterThan(roots.length);
    expect(parentOf.has(join(REPO_ROOT, "src/channels/inbound/pipeline.ts"))).toBe(true);
    // The CLI entry reaches every command module, through the commands barrel.
    expect(parentOf.has(join(REPO_ROOT, "src/cli/commands/index.ts"))).toBe(true);
    expect(parentOf.has(join(REPO_ROOT, "src/cli/commands/triggers.ts"))).toBe(true);
  });

  it("follows require() edges in real files", () => {
    // router-db.ts loads session-name.ts only through require().
    const routerDb = join(REPO_ROOT, "src/router/router-db.ts");
    expect(readEdges(routerDb).static).toContain(join(REPO_ROOT, "src/router/session-name.ts"));
  });

  it("(a) reaches no src/omni/** module and not src/omni-config.ts through static value imports", () => {
    const chains = reached.filter(isOmniTarget).map((file) => chainTo(file, parentOf));
    expect(chains).toEqual([]);
  });

  it("(b) imports the legacy bridge dynamically only from the allowed files", () => {
    const edges = reached.flatMap((file) =>
      readEdges(file)
        .dynamic.filter(isOmniTarget)
        .map((target) => ({ from: relative(REPO_ROOT, file), to: relative(REPO_ROOT, target) })),
    );
    const disallowed = edges.filter((edge) => !DYNAMIC_OMNI_ALLOWED.has(edge.from));

    expect(disallowed).toEqual([]);
    // The daemon loads the bridge lazily; this also proves dynamic edges are detected.
    expect(edges).toContainEqual({ from: "src/daemon-channels.ts", to: "src/omni/legacy-bridge.ts" });
  });
});

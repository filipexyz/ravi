import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listIndexedSpecs } from "./spec-db.js";
import { createSpec, getSpec, getSpecContext, listSpecs, syncSpecs } from "./service.js";

const tempRoots: string[] = [];
let isolatedStateDir: string | null = null;
let previousStateDir: string | undefined;

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-specs-"));
  tempRoots.push(root);
  return root;
}

beforeEach(async () => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  isolatedStateDir = await createIsolatedRaviState("ravi-specs-state-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(isolatedStateDir);
  isolatedStateDir = null;
  if (previousStateDir) {
    process.env.RAVI_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("specs service", () => {
  it("creates a feature spec with optional companion files", () => {
    const cwd = makeWorkspace();
    const result = createSpec({
      cwd,
      id: "channels/presence/lifecycle",
      title: "Presence Lifecycle",
      kind: "feature",
      full: true,
    });

    expect(result.spec).toMatchObject({
      id: "channels/presence/lifecycle",
      kind: "feature",
      domain: "channels",
      capability: "presence",
      feature: "lifecycle",
      title: "Presence Lifecycle",
      status: "active",
      normative: true,
    });
    expect(result.createdFiles.map((file) => file.split("/").at(-1))).toEqual([
      "SPEC.md",
      "WHY.md",
      "RUNBOOK.md",
      "CHECKS.md",
    ]);
    expect(result.missingAncestors.map((entry) => entry.id)).toEqual(["channels", "channels/presence"]);
    expect(existsSync(join(cwd, ".ravi/specs/channels/presence/lifecycle/SPEC.md"))).toBe(true);
  });

  it("lists and filters specs from markdown source of truth", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain" });

    expect(listSpecs({ cwd }).map((spec) => spec.id)).toEqual(["channels", "channels/presence", "runtime"]);
    expect(listSpecs({ cwd, domain: "channels" }).map((spec) => spec.id)).toEqual(["channels", "channels/presence"]);
    expect(listSpecs({ cwd, kind: "domain" }).map((spec) => spec.id)).toEqual(["channels", "runtime"]);
  });

  it("builds inherited context by mode", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });
    createSpec({ cwd, id: "channels/presence/lifecycle", title: "Presence Lifecycle", kind: "feature", full: true });

    const featureChecks = join(cwd, ".ravi/specs/channels/presence/lifecycle/CHECKS.md");
    mkdirSync(join(cwd, ".ravi/specs/channels/presence/lifecycle"), { recursive: true });
    const originalChecks = readFileSync(featureChecks, "utf8");
    writeFileSync(featureChecks, `${originalChecks}\n- Silent responses MUST stop presence immediately.\n`, "utf8");

    const rules = getSpecContext("channels/presence/lifecycle", { cwd });
    expect(rules.chain.map((entry) => entry.id)).toEqual([
      "channels",
      "channels/presence",
      "channels/presence/lifecycle",
    ]);
    expect(rules.files.map((file) => file.fileName)).toEqual(["SPEC.md", "SPEC.md", "SPEC.md"]);
    expect(rules.content).toContain("# channels / SPEC.md");
    expect(rules.content).toContain("# channels/presence/lifecycle / SPEC.md");

    const checks = getSpecContext("channels/presence/lifecycle", { cwd, mode: "checks" });
    expect(checks.files.map((file) => file.fileName)).toEqual(["CHECKS.md", "CHECKS.md", "CHECKS.md"]);
    expect(checks.requirements).toContainEqual(
      expect.objectContaining({
        level: "MUST",
        source: "channels/presence/lifecycle",
      }),
    );
  });

  it("syncs the rebuildable SQLite index from markdown", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });

    const synced = syncSpecs({ cwd });
    expect(synced.total).toBe(2);
    expect(synced.specs.map((spec) => spec.id)).toEqual(["channels", "channels/presence"]);
    expect(listIndexedSpecs(synced.rootPath).map((spec) => spec.id)).toEqual(["channels", "channels/presence"]);
  });

  it("rejects kind/path mismatches", () => {
    const cwd = makeWorkspace();
    expect(() =>
      createSpec({
        cwd,
        id: "channels/presence",
        title: "Presence",
        kind: "feature",
      }),
    ).toThrow("expected capability");
    expect(() => getSpec("channels/missing", { cwd })).toThrow("Spec not found");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listIndexedSpecs } from "./spec-db.js";
import { createSpec, getSpec, getSpecContext, listSpecs, syncSpecs, verifySpec } from "./service.js";

function specPath(cwd: string, id: string): string {
  return join(cwd, ".ravi/specs", ...id.split("/"), "SPEC.md");
}

// Replace a SPEC.md body while preserving its YAML frontmatter block.
function rewriteBody(path: string, body: string): void {
  const content = readFileSync(path, "utf8");
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/.exec(content);
  writeFileSync(path, `${match ? match[1] : ""}${body}`, "utf8");
}

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

  it("pre-populates the canonical template with --full and passes verify out of the box", () => {
    const cwd = makeWorkspace();
    const result = createSpec({ cwd, id: "memory/curation/loop", title: "Curation Loop", kind: "feature", full: true });

    const spec = readFileSync(result.spec.path, "utf8");
    expect(spec).toContain("lifecycle: proposed");
    expect(spec).toContain("implementation_status: none");
    expect(spec).toContain("## Acceptance Criteria");
    expect(spec).toContain("| R1 | Inspection | CHECKS.md#C1 |");
    expect(spec).toContain("## Adaptation");
    expect(spec).toContain("## Governance");

    const why = readFileSync(join(cwd, ".ravi/specs/memory/curation/loop/WHY.md"), "utf8");
    expect(why).toContain("## Alternatives Considered");
    const checks = readFileSync(join(cwd, ".ravi/specs/memory/curation/loop/CHECKS.md"), "utf8");
    expect(checks).toContain("C1");

    const verdict = verifySpec("memory/curation/loop", { cwd });
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toEqual([]);
    expect(verdict.summary).toMatchObject({ invariants: 1, acRows: 1, checks: 1 });
  });

  it("keeps the minimal template when --full is omitted", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const spec = readFileSync(specPath(cwd, "channels"), "utf8");
    expect(spec).not.toContain("lifecycle: proposed");
    expect(spec).toContain("This spec MUST define at least one concrete invariant.");
    expect(existsSync(join(cwd, ".ravi/specs/channels/CHECKS.md"))).toBe(false);
  });

  it("flags an invariant with no CHECKS.md and no AC row", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain" });
    // Non-full spec has no CHECKS.md; give it a numbered invariant and no AC row.
    const path = specPath(cwd, "runtime");
    rewriteBody(path, "# Runtime\n\n## Invariants\n\n- **R1** — Runtime MUST boot.\n");

    const verdict = verifySpec("runtime", { cwd });
    expect(verdict.ok).toBe(false);
    const codes = verdict.issues.map((issue) => issue.code);
    expect(codes).toContain("missing-checks-file");
    expect(codes).toContain("invariant-without-ac");
  });

  it("flags dangling check refs and invalid verification methods", () => {
    const cwd = makeWorkspace();
    // --full creates CHECKS.md with C1 (but not C9).
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain", full: true });
    const path = specPath(cwd, "runtime");
    // R1 valid; R2 references C9 (absent) with an unresolved method menu.
    rewriteBody(
      path,
      "# Runtime\n\n## Invariants\n\n- **R1** — MUST boot.\n- **R2** — MUST recover.\n" +
        "\n## Acceptance Criteria\n\n" +
        "| Invariant | Verification Method | Check Ref | Pass Condition |\n" +
        "|---|---|---|---|\n" +
        "| R1 | Inspection | CHECKS.md#C1 | ok |\n" +
        "| R2 | Test \\| Demonstration | CHECKS.md#C9 | ok |\n",
    );

    const verdict = verifySpec("runtime", { cwd });
    expect(verdict.ok).toBe(false);
    const codes = verdict.issues.map((issue) => issue.code);
    expect(codes).toContain("dangling-check-ref");
    expect(codes).toContain("ac-missing-method");
  });

  it("flags a bare TBD in Adaptation but accepts a resolution contract", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain", full: true });
    const path = specPath(cwd, "runtime");
    const validAc =
      "# Runtime\n\n## Invariants\n\n- **R1** — MUST boot.\n" +
      "\n## Acceptance Criteria\n\n" +
      "| Invariant | Verification Method | Check Ref | Pass Condition |\n" +
      "|---|---|---|---|\n" +
      "| R1 | Inspection | CHECKS.md#C1 | ok |\n";

    rewriteBody(path, `${validAc}\n## Adaptation\n\n- TBD: pick the eviction policy at runtime.\n`);
    const bare = verifySpec("runtime", { cwd });
    expect(bare.ok).toBe(false);
    expect(bare.issues.map((i) => i.code)).toContain("adaptation-unresolved");

    rewriteBody(
      path,
      `${validAc}\n## Adaptation\n\n- TBD: eviction policy — resolution_deadline: 2026-08-01, blocking_for: [R1].\n`,
    );
    expect(verifySpec("runtime", { cwd }).ok).toBe(true);
  });

  it("flags a bare TBD written as prose, but not the template's guidance prose (M1)", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain", full: true });
    const path = specPath(cwd, "runtime");
    const validAc =
      "# Runtime\n\n## Invariants\n\n- **R1** — MUST boot.\n" +
      "\n## Acceptance Criteria\n\n" +
      "| Invariant | Verification Method | Check Ref | Pass Condition |\n" +
      "|---|---|---|---|\n" +
      "| R1 | Inspection | CHECKS.md#C1 | ok |\n";

    // Prose decision marker (`TBD:` outside a bullet) must be caught.
    rewriteBody(path, `${validAc}\n## Adaptation\n\nTBD: decide the eviction policy at runtime.\n`);
    expect(verifySpec("runtime", { cwd }).issues.map((i) => i.code)).toContain("adaptation-unresolved");

    // Guidance prose that merely mentions the word (no decision marker) must NOT flag.
    rewriteBody(path, `${validAc}\n## Adaptation\n\nNo open decisions. Never leave a bare TBD here.\n`);
    const clean = verifySpec("runtime", { cwd });
    expect(clean.ok).toBe(true);
    expect(clean.issues.map((i) => i.code)).not.toContain("adaptation-unresolved");
  });

  it("warns (not silently passes) when a normative spec declares no invariants (M2)", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain" });
    const path = specPath(cwd, "runtime");
    rewriteBody(path, "# Runtime\n\n## Intent\n\nA normative spec with no numbered invariants.\n");

    const verdict = verifySpec("runtime", { cwd });
    const warning = verdict.issues.find((i) => i.code === "normative-without-invariants");
    expect(warning?.severity).toBe("warning");
    expect(verdict.ok).toBe(true); // a warning does not fail the lint
  });

  it("does not emit N redundant dangling-check-ref errors when CHECKS.md is absent (N1)", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain" });
    const path = specPath(cwd, "runtime");
    rewriteBody(
      path,
      "# Runtime\n\n## Invariants\n\n- **R1** — MUST boot.\n- **R2** — MUST recover.\n" +
        "\n## Acceptance Criteria\n\n" +
        "| Invariant | Verification Method | Check Ref | Pass Condition |\n" +
        "|---|---|---|---|\n" +
        "| R1 | Inspection | CHECKS.md#C1 | ok |\n" +
        "| R2 | Inspection | CHECKS.md#C2 | ok |\n",
    );

    const codes = verifySpec("runtime", { cwd }).issues.map((i) => i.code);
    expect(codes.filter((c) => c === "missing-checks-file")).toHaveLength(1);
    expect(codes).not.toContain("dangling-check-ref");
  });

  it("exempts non-normative specs from the AC contract", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "runtime", title: "Runtime", kind: "domain" });
    const path = specPath(cwd, "runtime");
    let content = readFileSync(path, "utf8").replace("normative: true", "normative: false");
    content += "\n## Invariants\n\n- **R1** — Runtime SHOULD boot.\n";
    writeFileSync(path, content, "utf8");

    const verdict = verifySpec("runtime", { cwd });
    expect(verdict.normative).toBe(false);
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toEqual([]);
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

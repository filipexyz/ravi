import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  applySpecsFacadePlan,
  buildSpecsFacadePlan,
  readbackSpecsFacade,
  recoverSpecsFacade,
  SpecsFacadeError,
  verifySpecsFacade,
} from "./facade.js";
import { listIndexedSpecs } from "./spec-db.js";
import { applyPreparedSpecCreation, createSpec, prepareSpecCreation } from "./service.js";

const tempRoots: string[] = [];
let isolatedStateDir: string | null = null;
let previousStateDir: string | undefined;

setDefaultTimeout(20_000);

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-specs-facade-"));
  tempRoots.push(root);
  return root;
}

beforeEach(async () => {
  previousStateDir = process.env.RAVI_STATE_DIR;
  isolatedStateDir = await createIsolatedRaviState("ravi-specs-facade-state-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(isolatedStateDir);
  isolatedStateDir = null;
  if (previousStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = previousStateDir;
  previousStateDir = undefined;

  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("specs facade", () => {
  it("plans new without creating files or the SQLite database", () => {
    const cwd = makeWorkspace();
    const plan = buildSpecsFacadePlan({ operation: "new", cwd, id: "channels", title: "Channels", kind: "domain" });

    expect(plan).toMatchObject({ operation: "new", executable: true, blockers: [] });
    expect(plan.planHash).toHaveLength(64);
    expect(existsSync(join(cwd, ".ravi"))).toBe(false);
    expect(existsSync(join(isolatedStateDir!, "ravi.db"))).toBe(false);
  });

  it("rejects an invalid id when the facade service is called directly", () => {
    const cwd = makeWorkspace();
    try {
      buildSpecsFacadePlan({ operation: "new", cwd, id: "a/b/c/d", title: "Invalid", kind: "feature" });
      throw new Error("Expected direct facade validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("INVALID_SPEC_INTENT");
    }
    expect(existsSync(join(cwd, ".ravi"))).toBe(false);
  });

  it("blocks a facade creation with missing ancestor specs", () => {
    const cwd = makeWorkspace();
    const intent = {
      operation: "new" as const,
      cwd,
      id: "channels/presence/lifecycle",
      title: "Presence Lifecycle",
      kind: "feature" as const,
      full: true,
    };
    const plan = buildSpecsFacadePlan(intent);

    expect(plan.executable).toBe(false);
    expect(plan.blockers[0]).toMatchObject({
      code: "SPEC_ANCESTORS_MISSING",
      details: { ancestors: ["channels", "channels/presence"] },
    });
    expect(() => applySpecsFacadePlan(intent, plan.planHash)).toThrow(SpecsFacadeError);
    expect(existsSync(join(cwd, ".ravi"))).toBe(false);

    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });
    try {
      applySpecsFacadePlan(intent, plan.planHash);
      throw new Error("Expected the formerly blocked plan to become stale");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("PLAN_STALE");
    }
  });

  it("applies an atomic quartet, verifies it, and replays the same plan as noop", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });
    const intent = {
      operation: "new" as const,
      cwd,
      id: "channels/presence/lifecycle",
      title: "Presence Lifecycle",
      kind: "feature" as const,
      full: true,
    };
    const plan = buildSpecsFacadePlan(intent);

    const first = applySpecsFacadePlan(intent, plan.planHash);
    expect(first).toMatchObject({ operation: "new", state: "created", changed: true });
    expect(first.verification.outcome).toBe("confirmed");
    const targetDir = join(cwd, ".ravi", "specs", "channels", "presence", "lifecycle");
    expect(["SPEC.md", "WHY.md", "RUNBOOK.md", "CHECKS.md"].every((name) => existsSync(join(targetDir, name)))).toBe(
      true,
    );

    const second = applySpecsFacadePlan(intent, plan.planHash);
    expect(second).toMatchObject({ operation: "new", state: "noop", changed: false });
    expect(verifySpecsFacade(intent, plan.planHash).outcome).toBe("confirmed");
  });

  it("does not promote a nested spec when an ancestor disappears before rename", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });
    const ancestorSpec = join(cwd, ".ravi", "specs", "channels", "presence", "SPEC.md");
    const targetDir = join(cwd, ".ravi", "specs", "channels", "presence", "lifecycle");
    const intent = {
      operation: "new" as const,
      cwd,
      id: "channels/presence/lifecycle",
      title: "Presence Lifecycle",
      kind: "feature" as const,
      full: true,
    };
    const plan = buildSpecsFacadePlan(intent);

    expect(() =>
      applySpecsFacadePlan(intent, plan.planHash, {
        beforePromote: () => rmSync(ancestorSpec),
      }),
    ).toThrow("Missing ancestor specs");
    expect(existsSync(targetDir)).toBe(false);
    expect(
      readdirSync(join(cwd, ".ravi", "specs", "channels", "presence")).some((name) =>
        name.includes(".lifecycle.ravi-stage-"),
      ),
    ).toBe(false);
  });

  it("classifies ancestor loss after apply as divergence and blocks replay", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    createSpec({ cwd, id: "channels/presence", title: "Presence", kind: "capability" });
    const intent = {
      operation: "new" as const,
      cwd,
      id: "channels/presence/lifecycle",
      title: "Presence Lifecycle",
      kind: "feature" as const,
      full: true,
    };
    const plan = buildSpecsFacadePlan(intent);
    applySpecsFacadePlan(intent, plan.planHash);

    rmSync(join(cwd, ".ravi", "specs", "channels", "presence", "SPEC.md"));

    expect(verifySpecsFacade(intent, plan.planHash).outcome).toBe("divergent");
    expect(recoverSpecsFacade(intent, plan.planHash)).toMatchObject({
      outcome: "divergent",
      action: "manual_review",
    });
    expect(buildSpecsFacadePlan(intent)).toMatchObject({
      executable: false,
      blockers: [{ code: "SPEC_ANCESTORS_MISSING" }],
    });
    expect(() => applySpecsFacadePlan(intent, plan.planHash)).toThrow("plan hash does not match");
  });

  it("reports post-apply file changes as divergent and requires manual review", () => {
    const cwd = makeWorkspace();
    const intent = {
      operation: "new" as const,
      cwd,
      id: "channels",
      title: "Channels",
      kind: "domain" as const,
      full: true,
    };
    const plan = buildSpecsFacadePlan(intent);
    applySpecsFacadePlan(intent, plan.planHash);
    const specPath = join(cwd, ".ravi", "specs", "channels", "SPEC.md");
    writeFileSync(specPath, `${readFileSync(specPath, "utf8")}\nExternally changed.\n`, "utf8");

    const verification = verifySpecsFacade(intent, plan.planHash);
    expect(verification.outcome).toBe("divergent");
    expect(verification.readback.files[0]).toMatchObject({ exists: true, regularFile: true, matches: false });
    expect(recoverSpecsFacade(intent, plan.planHash)).toMatchObject({
      outcome: "divergent",
      action: "manual_review",
      replay: false,
    });
    expect(() => applySpecsFacadePlan(intent, plan.planHash)).toThrow("plan hash does not match");
  });

  it("treats unexpected target files as divergence instead of exact replay", () => {
    const cwd = makeWorkspace();
    const intent = {
      operation: "new" as const,
      cwd,
      id: "channels",
      title: "Channels",
      kind: "domain" as const,
      full: true,
    };
    const plan = buildSpecsFacadePlan(intent);
    applySpecsFacadePlan(intent, plan.planHash);
    const unexpected = join(cwd, ".ravi", "specs", "channels", "NOTES.md");
    writeFileSync(unexpected, "unapproved", "utf8");

    const current = buildSpecsFacadePlan(intent);
    expect(current.executable).toBe(false);
    expect(current.blockers[0]).toMatchObject({
      code: "SPEC_TARGET_CONFLICT",
      details: { unexpectedFiles: [unexpected] },
    });

    const verification = verifySpecsFacade(intent, plan.planHash);
    expect(verification.outcome).toBe("divergent");
    expect(verification.readback.unexpectedFiles).toEqual([unexpected]);
    expect(recoverSpecsFacade(intent, plan.planHash)).toMatchObject({
      outcome: "divergent",
      action: "manual_review",
    });
    expect(() => applySpecsFacadePlan(intent, plan.planHash)).toThrow(SpecsFacadeError);
  });

  it("rejects a stale hash before writing", () => {
    const cwd = makeWorkspace();
    const planned = { operation: "new" as const, cwd, id: "channels", title: "Channels", kind: "domain" as const };
    const changed = { ...planned, title: "Changed title" };
    const plan = buildSpecsFacadePlan(planned);

    expect(() => applySpecsFacadePlan(changed, plan.planHash)).toThrow("plan hash does not match");
    expect(existsSync(join(cwd, ".ravi"))).toBe(false);
  });

  it("binds cwd, specs root, and database target into the plan hash", () => {
    const firstCwd = makeWorkspace();
    const secondCwd = makeWorkspace();
    const input = { operation: "new" as const, id: "channels", title: "Channels", kind: "domain" as const };
    const first = buildSpecsFacadePlan({ ...input, cwd: firstCwd });
    const second = buildSpecsFacadePlan({ ...input, cwd: secondCwd });

    expect(first.binding.cwd).not.toBe(second.binding.cwd);
    expect(first.planHash).not.toBe(second.planHash);

    const alternateState = makeWorkspace();
    process.env.RAVI_STATE_DIR = alternateState;
    const third = buildSpecsFacadePlan({ ...input, cwd: firstCwd });
    expect(third.binding.dbPath).not.toBe(first.binding.dbPath);
    expect(third.planHash).not.toBe(first.planHash);
  });

  it("canonicalizes a relative database binding without creating it", () => {
    const cwd = makeWorkspace();
    const relativeState = `.ravi-relative-state-${Date.now()}`;
    process.env.RAVI_STATE_DIR = relativeState;
    const plan = buildSpecsFacadePlan({ operation: "new", cwd, id: "channels", title: "Channels", kind: "domain" });

    expect(plan.binding.dbPath).toBe(resolve(relativeState, "ravi.db"));
    expect(resolve(plan.binding.dbPath)).toBe(plan.binding.dbPath);
    expect(existsSync(resolve(relativeState))).toBe(false);
  });

  it("rejects a symbolic link in the database binding when supported", () => {
    const cwd = makeWorkspace();
    const stateParent = makeWorkspace();
    const realState = join(stateParent, "real-state");
    const linkedState = join(stateParent, "linked-state");
    mkdirSync(realState);
    try {
      symlinkSync(realState, linkedState, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    process.env.RAVI_STATE_DIR = linkedState;

    try {
      buildSpecsFacadePlan({ operation: "sync", cwd });
      throw new Error("Expected unsafe database binding to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("UNSAFE_DB_PATH");
    }
    expect(existsSync(join(realState, "ravi.db"))).toBe(false);
  });

  it("does not overwrite an orphan target directory", () => {
    const cwd = makeWorkspace();
    const target = join(cwd, ".ravi", "specs", "channels");
    mkdirSync(target, { recursive: true });
    const orphan = join(target, "WHY.md");
    writeFileSync(orphan, "keep me", "utf8");
    const intent = { operation: "new" as const, cwd, id: "channels", title: "Channels", kind: "domain" as const };
    const plan = buildSpecsFacadePlan(intent);

    expect(plan.blockers[0]?.code).toBe("SPEC_TARGET_CONFLICT");
    expect(() => applySpecsFacadePlan(intent, plan.planHash)).toThrow(SpecsFacadeError);
    expect(readFileSync(orphan, "utf8")).toBe("keep me");
    expect(existsSync(join(target, "SPEC.md"))).toBe(false);
  });

  it("rejects a symbolic link in the write path when the platform supports links", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    mkdirSync(join(cwd, ".ravi"));
    try {
      symlinkSync(outside, join(cwd, ".ravi", "specs"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    expect(() =>
      buildSpecsFacadePlan({ operation: "new", cwd, id: "channels", title: "Channels", kind: "domain" }),
    ).toThrow("symbolic link");
    expect(existsSync(join(outside, "channels", "SPEC.md"))).toBe(false);
  });

  it("rejects a linked specs root before sync can scan external Markdown", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    createSpec({ cwd: outside, id: "external", title: "External", kind: "domain" });
    mkdirSync(join(cwd, ".ravi"));
    try {
      symlinkSync(join(outside, ".ravi", "specs"), join(cwd, ".ravi", "specs"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    try {
      buildSpecsFacadePlan({ operation: "sync", cwd });
      throw new Error("Expected unsafe specs root to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
    }
    expect(isolatedStateDir ? existsSync(join(isolatedStateDir, "ravi.db")) : false).toBe(false);
  });

  it("rejects an unrelated nested junction anywhere inside the specs tree", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const ignoredBranch = join(cwd, ".ravi", "specs", "ignored", "deep", "branch", "level");
    mkdirSync(ignoredBranch, { recursive: true });
    const junction = join(ignoredBranch, "unrelated-junction");
    try {
      symlinkSync(outside, junction, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    for (const intent of [
      { operation: "sync" as const, cwd },
      { operation: "new" as const, cwd, id: "runtime", title: "Runtime", kind: "domain" as const },
    ]) {
      try {
        buildSpecsFacadePlan(intent);
        throw new Error("Expected the unsafe descendant to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SpecsFacadeError);
        expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
      }
    }
    expect(existsSync(join(outside, "runtime", "SPEC.md"))).toBe(false);
    expect(existsSync(join(isolatedStateDir!, "ravi.db"))).toBe(false);
  });

  it("rejects linked spec and companion files before reading them", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain", full: true });
    const outsideFile = join(outside, "outside.md");
    writeFileSync(outsideFile, "outside", "utf8");

    for (const fileName of ["SPEC.md", "WHY.md"]) {
      const target = join(cwd, ".ravi", "specs", "channels", fileName);
      const original = readFileSync(target, "utf8");
      rmSync(target);
      try {
        symlinkSync(outsideFile, target, "file");
      } catch (error) {
        writeFileSync(target, original, "utf8");
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      try {
        buildSpecsFacadePlan({ operation: "sync", cwd });
        throw new Error("Expected the linked file to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(SpecsFacadeError);
        expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
      }
      rmSync(target);
      writeFileSync(target, original, "utf8");
    }
    expect(existsSync(join(isolatedStateDir!, "ravi.db"))).toBe(false);
  });

  it("rejects a junction introduced after validation before any effect", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const intent = { operation: "new" as const, cwd, id: "runtime", title: "Runtime", kind: "domain" as const };
    const plan = buildSpecsFacadePlan(intent);
    const junction = join(cwd, ".ravi", "specs", "late-junction");

    try {
      applySpecsFacadePlan(intent, plan.planHash, {
        afterValidation: () => symlinkSync(outside, junction, "junction"),
      });
      throw new Error("Expected the late unsafe descendant to fail");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
    }

    expect(existsSync(join(cwd, ".ravi", "specs", "runtime"))).toBe(false);
    expect(existsSync(join(outside, "SPEC.md"))).toBe(false);
  });

  it("rejects a junction introduced immediately before promotion and cleans staging", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const intent = { operation: "new" as const, cwd, id: "runtime", title: "Runtime", kind: "domain" as const };
    const plan = buildSpecsFacadePlan(intent);
    const specsRoot = join(cwd, ".ravi", "specs");

    try {
      applySpecsFacadePlan(intent, plan.planHash, {
        beforePromote: () => symlinkSync(outside, join(specsRoot, "promotion-junction"), "junction"),
      });
      throw new Error("Expected the promotion-time unsafe descendant to fail");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
    }

    expect(existsSync(join(specsRoot, "runtime"))).toBe(false);
    expect(readdirSync(specsRoot).some((entry) => entry.includes(".runtime.ravi-stage-"))).toBe(false);
  });

  it("rejects a junction introduced before sync without creating the index", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const intent = { operation: "sync" as const, cwd };
    const plan = buildSpecsFacadePlan(intent);

    try {
      applySpecsFacadePlan(intent, plan.planHash, {
        afterValidation: () => symlinkSync(outside, join(cwd, ".ravi", "specs", "late-sync-junction"), "junction"),
      });
      throw new Error("Expected the late sync junction to fail");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
    }

    expect(existsSync(join(isolatedStateDir!, "ravi.db"))).toBe(false);
  });

  it("rejects a target-path junction before planning creation", () => {
    const cwd = makeWorkspace();
    const outside = makeWorkspace();
    mkdirSync(join(cwd, ".ravi", "specs"), { recursive: true });
    try {
      symlinkSync(outside, join(cwd, ".ravi", "specs", "channels"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    try {
      buildSpecsFacadePlan({ operation: "new", cwd, id: "channels", title: "Channels", kind: "domain" });
      throw new Error("Expected the target junction to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SpecsFacadeError);
      expect((error as SpecsFacadeError).code).toBe("UNSAFE_SPECS_ROOT");
    }
    expect(existsSync(join(outside, "SPEC.md"))).toBe(false);
  });

  it("syncs once, then returns noop while readback remains confirmed", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const intent = { operation: "sync" as const, cwd };
    const plan = buildSpecsFacadePlan(intent);

    expect(verifySpecsFacade(intent, plan.planHash).outcome).toBe("absent");
    const first = applySpecsFacadePlan(intent, plan.planHash);
    expect(first).toMatchObject({ operation: "sync", state: "applied", changed: true });
    const second = applySpecsFacadePlan(intent, plan.planHash);
    expect(second).toMatchObject({ operation: "sync", state: "noop", changed: false });
    const readback = readbackSpecsFacade(intent, plan.planHash);
    expect(readback.index).toMatchObject({ matches: true, indexedTotal: 1, sourceTotal: 1 });
    expect(recoverSpecsFacade(intent, plan.planHash)).toMatchObject({
      outcome: "confirmed",
      action: "none",
      replay: false,
    });
  });

  it("sync writes the exact validated snapshot when Markdown changes before the write", () => {
    const cwd = makeWorkspace();
    createSpec({ cwd, id: "channels", title: "Channels", kind: "domain" });
    const specPath = join(cwd, ".ravi", "specs", "channels", "SPEC.md");
    const intent = { operation: "sync" as const, cwd };
    const plan = buildSpecsFacadePlan(intent);

    const result = applySpecsFacadePlan(intent, plan.planHash, {
      afterValidation: () => {
        const changed = readFileSync(specPath, "utf8").replace('title: "Channels"', 'title: "Changed"');
        writeFileSync(specPath, changed, "utf8");
        expect(changed).toContain('title: "Changed"');
      },
    });

    expect(result).toMatchObject({ operation: "sync", state: "applied", changed: true });
    expect(result.verification.outcome).toBe("confirmed");
    expect(listIndexedSpecs(join(cwd, ".ravi", "specs"))[0]?.title).toBe("Channels");
    expect(() => verifySpecsFacade(intent, plan.planHash)).toThrow("plan hash does not match");
  });

  it("cleans staging and exposes no target when promotion is interrupted", () => {
    const cwd = makeWorkspace();
    const prepared = prepareSpecCreation({ cwd, id: "channels", title: "Channels", kind: "domain", full: true });

    expect(() =>
      applyPreparedSpecCreation(prepared, {
        requireAncestors: true,
        existing: "noop",
        beforePromote: () => {
          throw new Error("injected promotion failure");
        },
      }),
    ).toThrow("injected promotion failure");
    expect(existsSync(prepared.directoryPath)).toBe(false);
    const parentEntries = existsSync(join(cwd, ".ravi", "specs")) ? readdirSync(join(cwd, ".ravi", "specs")) : [];
    expect(parentEntries.some((entry) => entry.includes("ravi-stage"))).toBe(false);
  });

  it("fails a competing creator closed while the pinned owner promotes, then replays as noop", () => {
    const cwd = makeWorkspace();
    const prepared = prepareSpecCreation({ cwd, id: "channels", title: "Channels", kind: "domain", full: true });
    let competitorError: unknown;

    const owner = applyPreparedSpecCreation(prepared, {
      requireAncestors: true,
      existing: "noop",
      beforePromote: () => {
        try {
          applyPreparedSpecCreation(prepared, {
            requireAncestors: true,
            existing: "noop",
          });
        } catch (error) {
          competitorError = error;
        }
      },
    });

    expect(owner.status).toBe("created");
    expect(competitorError).toBeInstanceOf(Error);
    expect(
      applyPreparedSpecCreation(
        prepareSpecCreation({ cwd, id: "channels", title: "Channels", kind: "domain", full: true }),
        {
          requireAncestors: true,
          existing: "noop",
        },
      ).status,
    ).toBe("noop");
    expect(
      ["SPEC.md", "WHY.md", "RUNBOOK.md", "CHECKS.md"].every((name) => existsSync(join(prepared.directoryPath, name))),
    ).toBe(true);
    const parentEntries = readdirSync(join(cwd, ".ravi", "specs"));
    expect(parentEntries.some((entry) => entry.includes("ravi-stage"))).toBe(false);
  });
});

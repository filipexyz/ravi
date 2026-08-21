import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  applySpecsFacadePlan,
  buildSpecsFacadePlan,
  readbackSpecsFacade,
  recoverSpecsFacade,
  SpecsFacadeError,
  verifySpecsFacade,
} from "./facade.js";
import { createSpec } from "./service.js";

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
});

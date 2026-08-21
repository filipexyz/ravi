import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { getRaviDbPath } from "../router/router-db.js";
import {
  applyPreparedSpecCreation,
  assertSafeSpecsTree,
  getSpecsRoot,
  inspectPreparedSpecCreation,
  listSpecs,
  prepareSpecCreation,
  syncSpecsSnapshot,
  UnsafeSpecsTreeError,
} from "./service.js";
import { inspectSpecsIndex } from "./spec-db.js";
import type { NewSpecInput, PreparedSpecCreation, SpecKind, SpecRecord } from "./types.js";

export const SPECS_FACADE_OPERATIONS = ["new", "sync"] as const;
export type SpecsFacadeOperation = (typeof SPECS_FACADE_OPERATIONS)[number];

export type SpecsFacadeIntent =
  | {
      operation: "new";
      cwd?: string;
      id: string;
      title: string;
      kind: SpecKind;
      full?: boolean;
    }
  | { operation: "sync"; cwd?: string };

export interface SpecsFacadePlan {
  schemaVersion: "specs.agent-first/v1";
  operation: SpecsFacadeOperation;
  planHash: string;
  executable: boolean;
  blockers: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  binding: {
    cwd: string;
    specsRoot: string;
    dbPath: string;
  };
  input: Record<string, unknown>;
  target: Record<string, unknown>;
  effects: Array<Record<string, unknown>>;
  observation: Record<string, unknown>;
}

export interface SpecsFacadeReadback {
  schemaVersion: "specs.agent-first/v1";
  operation: SpecsFacadeOperation;
  planHash: string;
  binding: SpecsFacadePlan["binding"];
  target: Record<string, unknown>;
  ancestors: Array<Record<string, unknown>>;
  files: Array<Record<string, unknown>>;
  unexpectedFiles: string[];
  index: ReturnType<typeof inspectSpecsIndex>;
  observedAt: string;
}

export interface SpecsFacadeVerification {
  operation: SpecsFacadeOperation;
  planHash: string;
  outcome: "confirmed" | "absent" | "divergent";
  readback: SpecsFacadeReadback;
}

export interface ApplySpecsFacadePlanOptions {
  /** Verification seam used to prove that writes consume the captured snapshot. */
  afterValidation?: () => void;
  /** Promotion seam used to prove that ancestor loss cannot publish a target. */
  beforePromote?: (stagingPath: string) => void;
}

interface SpecsFacadePlanState {
  plan: SpecsFacadePlan;
  prepared: PreparedSpecCreation | null;
  specs: SpecRecord[];
}

export class SpecsFacadeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SpecsFacadeError";
    this.code = code;
    this.details = details;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCwd(cwd?: string): string {
  const path = resolve(cwd ?? process.cwd());
  if (!existsSync(path)) throw new SpecsFacadeError("WORKSPACE_NOT_FOUND", `Workspace not found: ${path}`);
  return realpathSync(path);
}

function canonicalDatabasePath(): string {
  const path = resolve(getRaviDbPath());
  const root = parse(path).root;
  let current = root;
  for (const segment of path
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new SpecsFacadeError("UNSAFE_DB_PATH", `Unsafe symbolic link in Ravi database path: ${current}`, {
        path: current,
      });
    }
  }
  return path;
}

function canonicalSpecsRoot(cwd: string): string {
  const path = resolve(getSpecsRoot(cwd));
  const root = parse(path).root;
  let current = root;
  for (const segment of path
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", `Unsafe symbolic link in specs root: ${current}`, {
        path: current,
      });
    }
  }
  try {
    assertSafeSpecsTree(path);
  } catch (error) {
    if (error instanceof UnsafeSpecsTreeError) {
      throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", error.message, { path: error.unsafePath });
    }
    throw error;
  }
  return path;
}

function planHash(
  plan: Omit<SpecsFacadePlan, "planHash" | "executable" | "blockers" | "observation">,
  blockers: SpecsFacadePlan["blockers"],
): string {
  return sha256(canonicalJson({ ...plan, blockers }));
}

function comparableIndexSpec(spec: SpecRecord): Record<string, unknown> {
  return {
    rootPath: spec.rootPath,
    id: spec.id,
    path: spec.path,
    kind: spec.kind,
    domain: spec.domain,
    capability: spec.capability ?? null,
    feature: spec.feature ?? null,
    title: spec.title,
    capabilities: spec.capabilities,
    tags: spec.tags,
    appliesTo: spec.appliesTo,
    owners: spec.owners,
    status: spec.status,
    normative: spec.normative,
    mtime: spec.mtime,
  };
}

function bindingForCwd(cwd?: string): SpecsFacadePlan["binding"] {
  const canonical = canonicalCwd(cwd);
  return {
    cwd: canonical,
    specsRoot: canonicalSpecsRoot(canonical),
    dbPath: canonicalDatabasePath(),
  };
}

function assertCurrentSpecsBinding(expectedPath: string, cwd: string): void {
  const currentPath = canonicalSpecsRoot(cwd);
  if (currentPath !== expectedPath) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs root binding changed after planning", {
      expectedSpecsRoot: expectedPath,
      currentSpecsRoot: currentPath,
    });
  }
}

function assertCurrentDatabaseBinding(expectedPath: string): void {
  const currentPath = canonicalDatabasePath();
  if (currentPath !== expectedPath) {
    throw new SpecsFacadeError("PLAN_STALE", "Ravi database binding changed after planning", {
      expectedDbPath: expectedPath,
      currentDbPath: currentPath,
    });
  }
}

function newPlanState(intent: Extract<SpecsFacadeIntent, { operation: "new" }>): SpecsFacadePlanState {
  const binding = bindingForCwd(intent.cwd);
  let prepared: PreparedSpecCreation;
  try {
    prepared = prepareSpecCreation({ ...intent, cwd: binding.cwd } as NewSpecInput);
  } catch (error) {
    if (error instanceof UnsafeSpecsTreeError) {
      throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", error.message, { path: error.unsafePath });
    }
    throw new SpecsFacadeError("INVALID_SPEC_INTENT", error instanceof Error ? error.message : String(error), {
      operation: intent.operation,
    });
  }
  const inspection = inspectPreparedSpecCreation(prepared);
  const blockers: SpecsFacadePlan["blockers"] = [];
  if (prepared.missingAncestors.length > 0) {
    blockers.push({
      code: "SPEC_ANCESTORS_MISSING",
      message: `Missing ancestor specs for ${prepared.id}`,
      details: { ancestors: prepared.missingAncestors.map((entry) => entry.id) },
    });
  }
  if (inspection.targetSpecExists && !inspection.exactMatch) {
    blockers.push({
      code: "SPEC_TARGET_CONFLICT",
      message: `Spec already exists with different content: ${prepared.id}`,
      details: {
        divergentFiles: inspection.divergentFiles,
        missingFiles: inspection.missingFiles,
        unexpectedFiles: inspection.unexpectedFiles,
      },
    });
  } else if (inspection.targetDirectoryExists && !inspection.targetSpecExists) {
    blockers.push({
      code: "SPEC_TARGET_CONFLICT",
      message: `Spec target directory already exists without SPEC.md: ${prepared.id}`,
    });
  }

  const hashable = {
    schemaVersion: "specs.agent-first/v1" as const,
    operation: intent.operation,
    binding,
    input: {
      id: prepared.id,
      title: prepared.title,
      kind: prepared.kind,
      full: prepared.full,
    },
    target: { id: prepared.id, directoryPath: prepared.directoryPath },
    effects: prepared.files.map((file) => ({
      type: "create-file",
      path: file.path,
      contentSha256: sha256(file.content),
      overwrite: false,
    })),
  };
  return {
    prepared,
    specs: [],
    plan: {
      ...hashable,
      planHash: planHash(hashable, blockers),
      executable: blockers.length === 0,
      blockers,
      observation: {
        ancestors: prepared.ancestors.map((entry) => ({ id: entry.id, path: entry.path, exists: entry.exists })),
        target: inspection,
        replay: inspection.exactMatch ? "noop" : "create",
      },
    },
  };
}

function syncPlanState(intent: Extract<SpecsFacadeIntent, { operation: "sync" }>): SpecsFacadePlanState {
  const binding = bindingForCwd(intent.cwd);
  let specs: SpecRecord[];
  try {
    specs = listSpecs({ cwd: binding.cwd });
  } catch (error) {
    if (error instanceof UnsafeSpecsTreeError) {
      throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", error.message, { path: error.unsafePath });
    }
    throw error;
  }
  const source = specs.map(comparableIndexSpec);
  const index = inspectSpecsIndex(binding.specsRoot, specs, binding.dbPath);
  const sourceDigest = sha256(canonicalJson(source));
  const hashable = {
    schemaVersion: "specs.agent-first/v1" as const,
    operation: intent.operation,
    binding,
    input: { source: "workspace" as const },
    target: { dbPath: binding.dbPath, rootPath: binding.specsRoot },
    effects: [
      {
        type: "replace-index-if-changed",
        dbPath: binding.dbPath,
        rootPath: binding.specsRoot,
        sourceDigest,
        sourceTotal: specs.length,
      },
    ],
  };
  return {
    prepared: null,
    specs,
    plan: {
      ...hashable,
      planHash: planHash(hashable, []),
      executable: true,
      blockers: [],
      observation: {
        sourceFiles: specs.map((spec) => ({ id: spec.id, path: spec.path })),
        index,
        replay: index.matches ? "noop" : "sync",
      },
    },
  };
}

export function buildSpecsFacadePlan(intent: SpecsFacadeIntent): SpecsFacadePlan {
  return captureSpecsFacadePlan(intent).plan;
}

function captureSpecsFacadePlan(intent: SpecsFacadeIntent): SpecsFacadePlanState {
  return intent.operation === "new" ? newPlanState(intent) : syncPlanState(intent);
}

function hashablePlan(plan: SpecsFacadePlan) {
  return {
    schemaVersion: plan.schemaVersion,
    operation: plan.operation,
    binding: plan.binding,
    input: plan.input,
    target: plan.target,
    effects: plan.effects,
  };
}

function assertExpectedPlan(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadePlanState {
  const state = captureSpecsFacadePlan(intent);
  const plan = state.plan;
  if (!expectedPlanHash.trim() || plan.planHash !== expectedPlanHash.trim()) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs facade plan hash does not match the current intent and target", {
      expectedPlanHash: expectedPlanHash.trim() || null,
      currentPlanHash: plan.planHash,
    });
  }
  return state;
}

function assertExpectedObservationPlan(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadePlanState {
  const state = captureSpecsFacadePlan(intent);
  const expected = expectedPlanHash.trim();
  const executableHash = planHash(hashablePlan(state.plan), []);
  if (!expected || (state.plan.planHash !== expected && (intent.operation !== "new" || executableHash !== expected))) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs facade plan hash does not match the intended observed effect", {
      expectedPlanHash: expected || null,
      currentPlanHash: state.plan.planHash,
    });
  }
  return state;
}

function fileReadback(path: string, expectedSha256?: string): Record<string, unknown> {
  if (!existsSync(path)) return { path, exists: false, expectedSha256: expectedSha256 ?? null };
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { path, exists: true, regularFile: false, expectedSha256: expectedSha256 ?? null };
  }
  const actualSha256 = sha256(readFileSync(path, "utf8"));
  return {
    path,
    exists: true,
    regularFile: true,
    actualSha256,
    expectedSha256: expectedSha256 ?? null,
    matches: expectedSha256 ? actualSha256 === expectedSha256 : true,
  };
}

export function readbackSpecsFacade(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadeReadback {
  const state = assertExpectedObservationPlan(intent, expectedPlanHash);
  const plan = state.plan;
  assertCurrentSpecsBinding(plan.binding.specsRoot, plan.binding.cwd);
  assertCurrentDatabaseBinding(plan.binding.dbPath);
  if (intent.operation === "new") {
    const prepared = state.prepared!;
    const specs = listSpecs({ cwd: plan.binding.cwd });
    const inspection = inspectPreparedSpecCreation(prepared);
    return {
      schemaVersion: plan.schemaVersion,
      operation: plan.operation,
      planHash: expectedPlanHash.trim(),
      binding: plan.binding,
      target: plan.target,
      ancestors: prepared.ancestors.map((entry) => ({ id: entry.id, path: entry.path, exists: entry.exists })),
      files: plan.effects.map((effect) => fileReadback(String(effect.path), String(effect.contentSha256))),
      unexpectedFiles: inspection.unexpectedFiles,
      index: inspectSpecsIndex(plan.binding.specsRoot, specs, plan.binding.dbPath),
      observedAt: new Date().toISOString(),
    };
  }

  return readbackCapturedSync(state, expectedPlanHash.trim());
}

function readbackCapturedSync(state: SpecsFacadePlanState, expectedPlanHash: string): SpecsFacadeReadback {
  const plan = state.plan;
  assertCurrentSpecsBinding(plan.binding.specsRoot, plan.binding.cwd);
  assertCurrentDatabaseBinding(plan.binding.dbPath);
  return {
    schemaVersion: plan.schemaVersion,
    operation: plan.operation,
    planHash: expectedPlanHash,
    binding: plan.binding,
    target: plan.target,
    ancestors: [],
    files: state.specs.map((spec) => fileReadback(spec.path)),
    unexpectedFiles: [],
    index: inspectSpecsIndex(plan.binding.specsRoot, state.specs, plan.binding.dbPath),
    observedAt: new Date().toISOString(),
  };
}

function classifySpecsFacadeReadback(
  operation: SpecsFacadeOperation,
  expectedPlanHash: string,
  readback: SpecsFacadeReadback,
): SpecsFacadeVerification {
  let outcome: SpecsFacadeVerification["outcome"];
  if (operation === "new") {
    const existing = readback.files.filter((file) => file.exists === true);
    outcome =
      existing.length === 0
        ? "absent"
        : readback.ancestors.every((ancestor) => ancestor.exists) &&
            readback.unexpectedFiles.length === 0 &&
            readback.files.every((file) => file.matches === true)
          ? "confirmed"
          : "divergent";
  } else {
    outcome = readback.index.matches ? "confirmed" : readback.index.schemaExists ? "divergent" : "absent";
  }
  return { operation, planHash: expectedPlanHash, outcome, readback };
}

export function verifySpecsFacade(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadeVerification {
  return classifySpecsFacadeReadback(
    intent.operation,
    expectedPlanHash.trim(),
    readbackSpecsFacade(intent, expectedPlanHash),
  );
}

export function applySpecsFacadePlan(
  intent: SpecsFacadeIntent,
  expectedPlanHash: string,
  options: ApplySpecsFacadePlanOptions = {},
) {
  const state = assertExpectedPlan(intent, expectedPlanHash);
  const plan = state.plan;
  if (!plan.executable) {
    const blocker = plan.blockers[0]!;
    throw new SpecsFacadeError(blocker.code, blocker.message, blocker.details);
  }
  assertCurrentSpecsBinding(plan.binding.specsRoot, plan.binding.cwd);
  assertCurrentDatabaseBinding(plan.binding.dbPath);
  options.afterValidation?.();
  assertCurrentSpecsBinding(plan.binding.specsRoot, plan.binding.cwd);

  if (intent.operation === "new") {
    const result = applyPreparedSpecCreation(state.prepared!, {
      requireAncestors: true,
      existing: "noop",
      beforePromote: (stagingPath) => {
        options.beforePromote?.(stagingPath);
        assertCurrentSpecsBinding(plan.binding.specsRoot, plan.binding.cwd);
      },
    });
    const verification = verifySpecsFacade(intent, plan.planHash);
    if (verification.outcome !== "confirmed") {
      throw new SpecsFacadeError("SPEC_READBACK_DIVERGENT", "Spec files did not match the applied plan", {
        outcome: verification.outcome,
      });
    }
    return { operation: intent.operation, state: result.status, changed: result.changed, verification };
  }

  assertCurrentSpecsBinding(plan.binding.specsRoot, plan.binding.cwd);
  assertCurrentDatabaseBinding(plan.binding.dbPath);
  const result = syncSpecsSnapshot(state.specs, { cwd: plan.binding.cwd });
  const verification = classifySpecsFacadeReadback("sync", plan.planHash, readbackCapturedSync(state, plan.planHash));
  if (verification.outcome !== "confirmed") {
    throw new SpecsFacadeError("INDEX_READBACK_DIVERGENT", "Specs index did not match the Markdown source", {
      outcome: verification.outcome,
    });
  }
  return {
    operation: intent.operation,
    state: result.changed ? ("applied" as const) : ("noop" as const),
    changed: result.changed,
    verification,
  };
}

export function recoverSpecsFacade(intent: SpecsFacadeIntent, expectedPlanHash: string) {
  const verification = verifySpecsFacade(intent, expectedPlanHash);
  return {
    ...verification,
    action:
      verification.outcome === "confirmed"
        ? ("none" as const)
        : verification.outcome === "absent"
          ? ("replan_and_apply" as const)
          : ("manual_review" as const),
    replay: false as const,
  };
}

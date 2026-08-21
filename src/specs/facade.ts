import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getRaviDbPath } from "../router/router-db.js";
import {
  applyPreparedSpecCreation,
  captureSpecsTree,
  inspectPreparedSpecCreation,
  listSpecs,
  prepareSpecCreation,
  UnsafeSpecsTreeError,
} from "./service.js";
import { captureNativeDatabaseBinding, NativeSpecsSafetyError } from "./native-safe-fs.js";
import { inspectSpecsIndexBound, replaceSpecsIndexBound } from "./spec-db.js";
import type { CapturedSpecsTree } from "./service.js";
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
    workspaceIdentity: string;
    rootBinding: string;
    dbBinding: string;
    dbParentExists: boolean;
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
  index: ReturnType<typeof inspectSpecsIndexBound>;
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
  /** Native seam immediately after the final stage identity check. */
  beforeNativePromote?: (stagingPath: string, originalRecoveryPath: string) => void;
  /** Native seam after the database plan binding is pinned and before SQLite opens. */
  beforeDatabaseOpen?: () => void;
  /** Native seam after the database file is pinned and immediately before SQLite opens. */
  beforeDatabaseWrite?: (safePath: string) => void;
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

function throwFacadeSpecsError(error: unknown): never {
  if (error instanceof UnsafeSpecsTreeError) {
    throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", error.message, { path: error.unsafePath });
  }
  if (error instanceof NativeSpecsSafetyError) {
    throw new SpecsFacadeError(error.code, error.message, { path: error.unsafePath });
  }
  throw error;
}

function captureFacadeSpecsTree(cwd: string): CapturedSpecsTree {
  try {
    return captureSpecsTree(cwd);
  } catch (error) {
    return throwFacadeSpecsError(error);
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
  return resolve(getRaviDbPath());
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
  let captured: CapturedSpecsTree;
  try {
    captured = captureSpecsTree(canonical);
  } catch (error) {
    if (error instanceof UnsafeSpecsTreeError) {
      throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", error.message, { path: error.unsafePath });
    }
    throw error;
  }
  return {
    cwd: canonical,
    specsRoot: captured.rootPath,
    dbPath: canonicalDatabasePath(),
    workspaceIdentity: captured.workspaceIdentity,
    rootBinding: captured.rootBinding,
    ...(() => {
      try {
        const database = captureNativeDatabaseBinding(canonicalDatabasePath());
        return { dbBinding: database.binding, dbParentExists: database.parentExists };
      } catch (error) {
        if (error instanceof NativeSpecsSafetyError && error.code === "UNSAFE_LINK") {
          throw new SpecsFacadeError("UNSAFE_DB_PATH", error.message, { path: error.unsafePath });
        }
        return throwFacadeSpecsError(error);
      }
    })(),
  };
}

function assertCurrentSpecsBinding(
  expectedPath: string,
  expectedWorkspaceIdentity: string,
  expectedRootBinding: string,
  cwd: string,
): void {
  const current = captureFacadeSpecsTree(cwd);
  if (
    current.rootPath !== expectedPath ||
    current.workspaceIdentity !== expectedWorkspaceIdentity ||
    current.rootBinding !== expectedRootBinding
  ) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs root binding changed after planning", {
      expectedSpecsRoot: expectedPath,
      currentSpecsRoot: current.rootPath,
      expectedWorkspaceIdentity,
      currentWorkspaceIdentity: current.workspaceIdentity,
      expectedRootBinding,
      currentRootBinding: current.rootBinding,
    });
  }
}

function assertCurrentDatabaseBinding(expectedPath: string, expectedBinding: string): void {
  const currentPath = canonicalDatabasePath();
  let currentBinding: string;
  try {
    currentBinding = captureNativeDatabaseBinding(currentPath).binding;
  } catch (error) {
    throwFacadeSpecsError(error);
  }
  if (currentPath !== expectedPath || currentBinding !== expectedBinding) {
    throw new SpecsFacadeError("PLAN_STALE", "Ravi database binding changed after planning", {
      expectedDbPath: expectedPath,
      currentDbPath: currentPath,
      expectedDbBinding: expectedBinding,
      currentDbBinding: currentBinding,
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
  const index = inspectSpecsIndexBound(binding.specsRoot, specs, binding.dbPath, binding.dbBinding);
  const sourceDigest = sha256(canonicalJson(source));
  const blockers: SpecsFacadePlan["blockers"] = binding.dbParentExists
    ? []
    : [
        {
          code: "DB_PARENT_NOT_FOUND",
          message: `Ravi database parent directory does not exist: ${binding.dbPath}`,
        },
      ];
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
      planHash: planHash(hashable, blockers),
      executable: blockers.length === 0,
      blockers,
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

function bindingVariants(binding: SpecsFacadePlan["binding"]): SpecsFacadePlan["binding"][] {
  const roots = new Set([binding.rootBinding]);
  const rootMatch = /^workspace:([^;]+);ravi:([^;]+);specs:([^;]+)$/.exec(binding.rootBinding);
  if (rootMatch) {
    roots.add(`workspace:${rootMatch[1]};ravi:missing;specs:missing`);
    if (rootMatch[2] !== "missing") roots.add(`workspace:${rootMatch[1]};ravi:${rootMatch[2]};specs:missing`);
  }
  const databases = new Set([binding.dbBinding]);
  if (/;file:[^;]+$/.test(binding.dbBinding)) {
    databases.add(binding.dbBinding.replace(/;file:[^;]+$/, ";file:missing"));
  }
  return [...roots].flatMap((rootBinding) =>
    [...databases].map((dbBinding) => ({ ...binding, rootBinding, dbBinding })),
  );
}

function acceptedObservationHashes(plan: SpecsFacadePlan): Set<string> {
  return new Set(bindingVariants(plan.binding).map((binding) => planHash({ ...hashablePlan(plan), binding }, [])));
}

function assertExpectedPlan(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadePlanState {
  const state = captureSpecsFacadePlan(intent);
  const plan = state.plan;
  const expected = expectedPlanHash.trim();
  const exactReplay =
    plan.executable && state.plan.observation.replay === "noop" && acceptedObservationHashes(plan).has(expected);
  if (!expected || (plan.planHash !== expected && !exactReplay)) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs facade plan hash does not match the current intent and target", {
      expectedPlanHash: expectedPlanHash.trim() || null,
      currentPlanHash: plan.planHash,
    });
  }
  return plan.planHash === expected ? state : { ...state, plan: { ...plan, planHash: expected } };
}

function assertExpectedObservationPlan(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadePlanState {
  const state = captureSpecsFacadePlan(intent);
  const expected = expectedPlanHash.trim();
  const accepted = acceptedObservationHashes(state.plan);
  if (!expected || (state.plan.planHash !== expected && !accepted.has(expected))) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs facade plan hash does not match the intended observed effect", {
      expectedPlanHash: expected || null,
      currentPlanHash: state.plan.planHash,
    });
  }
  return state.plan.planHash === expected ? state : { ...state, plan: { ...state.plan, planHash: expected } };
}

function fileReadback(snapshot: CapturedSpecsTree, path: string, expectedSha256?: string): Record<string, unknown> {
  const candidate = relative(snapshot.rootPath, path);
  if (candidate.startsWith("..") || isAbsolute(candidate)) {
    throw new SpecsFacadeError("UNSAFE_SPECS_ROOT", `Readback path escaped the bound specs root: ${path}`);
  }
  const key = candidate.split(/[\\/]+/).join("/");
  const entry = snapshot.entries.find((current) => current.relativePath === key);
  if (!entry) return { path, exists: false, expectedSha256: expectedSha256 ?? null };
  if (entry.kind !== "file" || entry.content === undefined) {
    return { path, exists: true, regularFile: false, expectedSha256: expectedSha256 ?? null };
  }
  const actualSha256 = sha256(entry.content);
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
  assertCurrentSpecsBinding(
    plan.binding.specsRoot,
    plan.binding.workspaceIdentity,
    plan.binding.rootBinding,
    plan.binding.cwd,
  );
  assertCurrentDatabaseBinding(plan.binding.dbPath, plan.binding.dbBinding);
  if (intent.operation === "new") {
    const prepared = state.prepared!;
    const specs = listSpecs({ cwd: plan.binding.cwd });
    const observedTree = captureFacadeSpecsTree(plan.binding.cwd);
    const inspection = inspectPreparedSpecCreation(prepared);
    return {
      schemaVersion: plan.schemaVersion,
      operation: plan.operation,
      planHash: expectedPlanHash.trim(),
      binding: plan.binding,
      target: plan.target,
      ancestors: prepared.ancestors.map((entry) => ({ id: entry.id, path: entry.path, exists: entry.exists })),
      files: plan.effects.map((effect) =>
        fileReadback(observedTree, String(effect.path), String(effect.contentSha256)),
      ),
      unexpectedFiles: inspection.unexpectedFiles,
      index: inspectSpecsIndexBound(plan.binding.specsRoot, specs, plan.binding.dbPath, plan.binding.dbBinding),
      observedAt: new Date().toISOString(),
    };
  }

  return readbackCapturedSync(state, expectedPlanHash.trim());
}

function readbackCapturedSync(state: SpecsFacadePlanState, expectedPlanHash: string): SpecsFacadeReadback {
  const plan = state.plan;
  assertCurrentSpecsBinding(
    plan.binding.specsRoot,
    plan.binding.workspaceIdentity,
    plan.binding.rootBinding,
    plan.binding.cwd,
  );
  const currentDatabase = captureNativeDatabaseBinding(plan.binding.dbPath);
  const observedTree = captureFacadeSpecsTree(plan.binding.cwd);
  return {
    schemaVersion: plan.schemaVersion,
    operation: plan.operation,
    planHash: expectedPlanHash,
    binding: plan.binding,
    target: plan.target,
    ancestors: [],
    files: state.specs.map((spec) => fileReadback(observedTree, spec.path)),
    unexpectedFiles: [],
    index: inspectSpecsIndexBound(plan.binding.specsRoot, state.specs, plan.binding.dbPath, currentDatabase.binding),
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
  assertCurrentSpecsBinding(
    plan.binding.specsRoot,
    plan.binding.workspaceIdentity,
    plan.binding.rootBinding,
    plan.binding.cwd,
  );
  assertCurrentDatabaseBinding(plan.binding.dbPath, plan.binding.dbBinding);
  options.afterValidation?.();
  assertCurrentSpecsBinding(
    plan.binding.specsRoot,
    plan.binding.workspaceIdentity,
    plan.binding.rootBinding,
    plan.binding.cwd,
  );

  if (intent.operation === "new") {
    let result: ReturnType<typeof applyPreparedSpecCreation>;
    try {
      result = applyPreparedSpecCreation(state.prepared!, {
        requireAncestors: true,
        existing: "noop",
        beforePromote: (stagingPath) => {
          options.beforePromote?.(stagingPath);
        },
        beforeNativePromote: (stagingPath, recoveryPath) => {
          options.beforeNativePromote?.(stagingPath, recoveryPath);
        },
      });
    } catch (error) {
      return throwFacadeSpecsError(error);
    }
    const verification = verifySpecsFacade(intent, plan.planHash);
    if (verification.outcome !== "confirmed") {
      throw new SpecsFacadeError("SPEC_READBACK_DIVERGENT", "Spec files did not match the applied plan", {
        outcome: verification.outcome,
      });
    }
    return { operation: intent.operation, state: result.status, changed: result.changed, verification };
  }

  assertCurrentSpecsBinding(
    plan.binding.specsRoot,
    plan.binding.workspaceIdentity,
    plan.binding.rootBinding,
    plan.binding.cwd,
  );
  assertCurrentDatabaseBinding(plan.binding.dbPath, plan.binding.dbBinding);
  let changed: boolean;
  try {
    changed = replaceSpecsIndexBound(plan.binding.specsRoot, state.specs, plan.binding.dbPath, plan.binding.dbBinding, {
      ...(options.beforeDatabaseOpen ? { beforeOpen: options.beforeDatabaseOpen } : {}),
      ...(options.beforeDatabaseWrite ? { beforeCallback: options.beforeDatabaseWrite } : {}),
    });
  } catch (error) {
    return throwFacadeSpecsError(error);
  }
  const verification = classifySpecsFacadeReadback("sync", plan.planHash, readbackCapturedSync(state, plan.planHash));
  if (verification.outcome !== "confirmed") {
    throw new SpecsFacadeError("INDEX_READBACK_DIVERGENT", "Specs index did not match the Markdown source", {
      outcome: verification.outcome,
    });
  }
  return {
    operation: intent.operation,
    state: changed ? ("applied" as const) : ("noop" as const),
    changed,
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

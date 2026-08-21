import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getRaviDbPath } from "../router/router-db.js";
import {
  applyPreparedSpecCreation,
  getSpecsRoot,
  inspectPreparedSpecCreation,
  listSpecs,
  prepareSpecCreation,
  syncSpecs,
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
  index: ReturnType<typeof inspectSpecsIndex>;
  observedAt: string;
}

export interface SpecsFacadeVerification {
  operation: SpecsFacadeOperation;
  planHash: string;
  outcome: "confirmed" | "absent" | "divergent";
  readback: SpecsFacadeReadback;
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
    specsRoot: getSpecsRoot(canonical),
    dbPath: getRaviDbPath(),
  };
}

function newPlan(intent: Extract<SpecsFacadeIntent, { operation: "new" }>): SpecsFacadePlan {
  let prepared: PreparedSpecCreation;
  try {
    prepared = prepareSpecCreation(intent as NewSpecInput);
  } catch (error) {
    throw new SpecsFacadeError("INVALID_SPEC_INTENT", error instanceof Error ? error.message : String(error), {
      operation: intent.operation,
    });
  }
  const binding = bindingForCwd(prepared.cwd);
  const inspection = inspectPreparedSpecCreation(prepared);
  const blockers: SpecsFacadePlan["blockers"] = [];
  if (prepared.missingAncestors.length > 0 && !inspection.exactMatch) {
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
      details: { divergentFiles: inspection.divergentFiles, missingFiles: inspection.missingFiles },
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
    ...hashable,
    planHash: planHash(hashable, blockers),
    executable: blockers.length === 0,
    blockers,
    observation: {
      ancestors: prepared.ancestors.map((entry) => ({ id: entry.id, path: entry.path, exists: entry.exists })),
      target: inspection,
      replay: inspection.exactMatch ? "noop" : "create",
    },
  };
}

function syncPlan(intent: Extract<SpecsFacadeIntent, { operation: "sync" }>): SpecsFacadePlan {
  const binding = bindingForCwd(intent.cwd);
  const specs = listSpecs({ cwd: binding.cwd });
  const source = specs.map(comparableIndexSpec);
  const index = inspectSpecsIndex(binding.specsRoot, specs);
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
    ...hashable,
    planHash: planHash(hashable, []),
    executable: true,
    blockers: [],
    observation: {
      sourceFiles: specs.map((spec) => ({ id: spec.id, path: spec.path })),
      index,
      replay: index.matches ? "noop" : "sync",
    },
  };
}

export function buildSpecsFacadePlan(intent: SpecsFacadeIntent): SpecsFacadePlan {
  return intent.operation === "new" ? newPlan(intent) : syncPlan(intent);
}

function assertExpectedPlan(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadePlan {
  const plan = buildSpecsFacadePlan(intent);
  if (!expectedPlanHash.trim() || plan.planHash !== expectedPlanHash.trim()) {
    throw new SpecsFacadeError("PLAN_STALE", "Specs facade plan hash does not match the current intent and target", {
      expectedPlanHash: expectedPlanHash.trim() || null,
      currentPlanHash: plan.planHash,
    });
  }
  return plan;
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
  const plan = assertExpectedPlan(intent, expectedPlanHash);
  const specs = listSpecs({ cwd: plan.binding.cwd });
  if (intent.operation === "new") {
    const prepared = prepareSpecCreation(intent as NewSpecInput);
    return {
      schemaVersion: plan.schemaVersion,
      operation: plan.operation,
      planHash: plan.planHash,
      binding: plan.binding,
      target: plan.target,
      ancestors: prepared.ancestors.map((entry) => ({ id: entry.id, path: entry.path, exists: entry.exists })),
      files: plan.effects.map((effect) => fileReadback(String(effect.path), String(effect.contentSha256))),
      index: inspectSpecsIndex(plan.binding.specsRoot, specs),
      observedAt: new Date().toISOString(),
    };
  }

  return {
    schemaVersion: plan.schemaVersion,
    operation: plan.operation,
    planHash: plan.planHash,
    binding: plan.binding,
    target: plan.target,
    ancestors: [],
    files: specs.map((spec) => fileReadback(spec.path)),
    index: inspectSpecsIndex(plan.binding.specsRoot, specs),
    observedAt: new Date().toISOString(),
  };
}

export function verifySpecsFacade(intent: SpecsFacadeIntent, expectedPlanHash: string): SpecsFacadeVerification {
  const readback = readbackSpecsFacade(intent, expectedPlanHash);
  let outcome: SpecsFacadeVerification["outcome"];
  if (intent.operation === "new") {
    const existing = readback.files.filter((file) => file.exists === true);
    outcome =
      existing.length === 0
        ? "absent"
        : readback.files.every((file) => file.matches === true)
          ? "confirmed"
          : "divergent";
  } else {
    outcome = readback.index.matches ? "confirmed" : readback.index.schemaExists ? "divergent" : "absent";
  }
  return { operation: intent.operation, planHash: readback.planHash, outcome, readback };
}

export function applySpecsFacadePlan(intent: SpecsFacadeIntent, expectedPlanHash: string) {
  const plan = assertExpectedPlan(intent, expectedPlanHash);
  if (!plan.executable) {
    const blocker = plan.blockers[0]!;
    throw new SpecsFacadeError(blocker.code, blocker.message, blocker.details);
  }

  if (intent.operation === "new") {
    const result = applyPreparedSpecCreation(prepareSpecCreation(intent as NewSpecInput), {
      requireAncestors: true,
      existing: "noop",
    });
    const verification = verifySpecsFacade(intent, plan.planHash);
    if (verification.outcome !== "confirmed") {
      throw new SpecsFacadeError("SPEC_READBACK_DIVERGENT", "Spec files did not match the applied plan", {
        outcome: verification.outcome,
      });
    }
    return { operation: intent.operation, state: result.status, changed: result.changed, verification };
  }

  const result = syncSpecs({ cwd: plan.binding.cwd });
  const verification = verifySpecsFacade(intent, plan.planHash);
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

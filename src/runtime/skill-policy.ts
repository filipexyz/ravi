import { createHash } from "node:crypto";

export type SkillRequirement =
  | { readonly kind: "none" }
  | { readonly kind: "any-of"; readonly alternatives: readonly (readonly string[])[] };

export interface SkillCatalogEntry {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly name: string;
  readonly description?: string;
  readonly resource: {
    readonly path: string;
    readonly pluginPath?: string;
    readonly files?: readonly { readonly path: string; readonly content: string }[];
  };
  readonly requirements?: SkillRequirement;
}

export interface SkillPolicyScope {
  readonly agentId: string;
  readonly executionId: string;
  readonly contextKey: string;
}

export interface SkillPolicyRevisions {
  readonly policy: string;
  readonly catalog: string;
  readonly permissions: string;
  readonly toolSurface: string;
}

export type SkillSelectionSource = "baseline" | "capability" | "grant" | "local";
export interface SkillPolicyDiagnostic {
  readonly skillId?: string;
  readonly code: string;
  readonly detail?: string;
}

export interface SkillPolicySelection {
  readonly baseline: readonly string[];
  readonly fromCapabilities: readonly string[];
  readonly fromGrants: readonly string[];
  readonly local: readonly string[];
}

export interface SkillPolicyInput {
  readonly scope: SkillPolicyScope;
  readonly revisions: SkillPolicyRevisions;
  readonly catalog: readonly SkillCatalogEntry[];
  readonly selection: SkillPolicySelection;
  readonly capabilityState: { readonly available: readonly string[]; readonly authorized: readonly string[] };
}

export interface SkillPolicySnapshot {
  readonly contractVersion: 1;
  readonly id: string;
  readonly status: "ready" | "empty";
  readonly scope: SkillPolicyScope;
  readonly revisions: SkillPolicyRevisions;
  readonly skills: readonly SkillCatalogEntry[];
  readonly provenance: Readonly<Record<string, readonly SkillSelectionSource[]>>;
  readonly diagnostics: readonly SkillPolicyDiagnostic[];
}

export class SkillPolicyError extends Error {
  readonly code = "RAVI_SKILL_POLICY_RESOLUTION_ERROR";

  constructor(detail: string) {
    super(`RAVI_SKILL_POLICY_RESOLUTION_ERROR: ${detail}`);
    this.name = "SkillPolicyError";
  }
}

export function resolveSkillPolicy(input: SkillPolicyInput): SkillPolicySnapshot {
  if (
    !input?.scope ||
    !input.revisions ||
    ![
      input.scope.agentId,
      input.scope.executionId,
      input.scope.contextKey,
      input.revisions.policy,
      input.revisions.catalog,
      input.revisions.permissions,
      input.revisions.toolSurface,
    ].every(nonemptyString)
  ) {
    throw new SkillPolicyError("A resolved scope and all policy revisions are required.");
  }
  if (
    !Array.isArray(input.catalog) ||
    !input.selection ||
    !input.capabilityState ||
    ![
      input.selection.baseline,
      input.selection.fromCapabilities,
      input.selection.fromGrants,
      input.selection.local,
      input.capabilityState.available,
      input.capabilityState.authorized,
    ].every(stringList)
  ) {
    throw new SkillPolicyError("Catalog, selections and both capability sets must be resolved explicitly.");
  }

  const diagnostics: SkillPolicyDiagnostic[] = [];
  const entries = new Map<string, SkillCatalogEntry>();
  const aliasOwners = new Map<string, Set<string>>();
  const ambiguous = new Set<string>();
  for (const skill of input.catalog) {
    if (!validCatalogIdentity(skill)) {
      diagnostics.push({ ...(typeof skill?.id === "string" ? { skillId: skill.id } : {}), code: "invalid-identity" });
      continue;
    }
    const normalized = copySkillCatalogEntry(skill);
    const previous = entries.get(skill.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) ambiguous.add(skill.id);
    entries.set(skill.id, normalized);
    for (const alias of [skill.id, ...skill.aliases]) {
      const key = aliasKey(alias);
      const owners = aliasOwners.get(key) ?? new Set<string>();
      owners.add(skill.id);
      aliasOwners.set(key, owners);
    }
  }
  for (const owners of aliasOwners.values()) {
    if (owners.size > 1) for (const owner of owners) ambiguous.add(owner);
  }
  for (const skillId of ambiguous) diagnostics.push({ skillId, code: "ambiguous-identity" });

  const selected = new Map<string, Set<SkillSelectionSource>>();
  const selectionGroups: readonly [SkillSelectionSource, readonly string[]][] = [
    ["baseline", input.selection.baseline],
    ["capability", input.selection.fromCapabilities],
    ["grant", input.selection.fromGrants],
    ["local", input.selection.local],
  ];
  for (const [source, names] of selectionGroups) {
    for (const name of names) {
      const owners = aliasOwners.get(aliasKey(name));
      if (!owners?.size) {
        diagnostics.push({ skillId: name, code: "unknown-selection" });
        continue;
      }
      for (const id of owners) {
        const sources = selected.get(id) ?? new Set<SkillSelectionSource>();
        sources.add(source);
        selected.set(id, sources);
      }
    }
  }

  const available = new Set(input.capabilityState.available);
  const authorized = new Set(input.capabilityState.authorized);
  const skills: SkillCatalogEntry[] = [];
  const provenance: Record<string, readonly SkillSelectionSource[]> = {};
  for (const skill of [...entries.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (ambiguous.has(skill.id)) continue;
    const sources = selected.get(skill.id);
    if (!sources) {
      diagnostics.push({ skillId: skill.id, code: "not-selected" });
      continue;
    }
    if (skill.requirements === undefined) {
      diagnostics.push({ skillId: skill.id, code: "missing-requirements" });
      continue;
    }
    const requirements = parseSkillRequirement(skill.requirements);
    if (!requirements) {
      diagnostics.push({ skillId: skill.id, code: "invalid-requirements" });
      continue;
    }
    if (
      requirements.kind === "any-of" &&
      !requirements.alternatives.some((clause) => clause.every((id) => available.has(id) && authorized.has(id)))
    ) {
      const required = new Set(requirements.alternatives.flat());
      if ([...required].some((id) => !available.has(id)))
        diagnostics.push({ skillId: skill.id, code: "unavailable-capability" });
      if ([...required].some((id) => !authorized.has(id)))
        diagnostics.push({ skillId: skill.id, code: "unauthorized-capability" });
      continue;
    }
    skills.push(copySkillCatalogEntry({ ...skill, requirements }));
    provenance[skill.id] = Object.freeze(
      selectionGroups.map(([source]) => source).filter((source) => sources.has(source)),
    );
  }

  const scope = Object.freeze({ ...input.scope });
  const revisions = Object.freeze({ ...input.revisions });
  const uniqueDiagnostics = [
    ...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values(),
  ]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    .map((diagnostic) => Object.freeze({ ...diagnostic }));
  const result: SkillPolicySnapshot = {
    contractVersion: 1,
    id: skillPolicyHash({ scope, revisions, skills, provenance, diagnostics: uniqueDiagnostics }),
    status: skills.length > 0 ? "ready" : "empty",
    scope,
    revisions,
    skills: Object.freeze(skills),
    provenance: Object.freeze(provenance),
    diagnostics: Object.freeze(uniqueDiagnostics),
  };
  return Object.freeze(result);
}

/** Strict JSON-boundary validation; an empty clause never means independence. */
export function parseSkillRequirement(value: unknown): SkillRequirement | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "none" && Object.keys(value).length === 1) return Object.freeze({ kind: "none" });
  if (
    value.kind !== "any-of" ||
    Object.keys(value).length !== 2 ||
    !Array.isArray(value.alternatives) ||
    value.alternatives.length === 0
  )
    return undefined;
  const clauses: (readonly string[])[] = [];
  for (const alternative of value.alternatives) {
    if (!Array.isArray(alternative) || alternative.length === 0 || !alternative.every(validIdentifier))
      return undefined;
    clauses.push(Object.freeze([...new Set<string>(alternative)].sort()));
  }
  const alternatives = [...new Map(clauses.map((clause) => [JSON.stringify(clause), clause])).values()].sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return Object.freeze({ kind: "any-of", alternatives: Object.freeze(alternatives) });
}

export function skillPolicyHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function copySkillCatalogEntry(skill: SkillCatalogEntry): SkillCatalogEntry {
  const requirements = skill.requirements === undefined ? undefined : parseSkillRequirement(skill.requirements);
  return Object.freeze({
    id: skill.id,
    aliases: Object.freeze([...new Set(skill.aliases)].sort()),
    name: skill.name,
    ...(skill.description === undefined ? {} : { description: skill.description }),
    resource: Object.freeze({
      path: skill.resource.path,
      ...(skill.resource.pluginPath === undefined ? {} : { pluginPath: skill.resource.pluginPath }),
      ...(skill.resource.files === undefined
        ? {}
        : {
            files: Object.freeze(
              skill.resource.files
                .map((file) => Object.freeze({ path: file.path, content: file.content }))
                .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
            ),
          }),
    }),
    ...(requirements === undefined ? {} : { requirements }),
  });
}

function aliasKey(value: string): string {
  return value.trim().toLowerCase();
}
function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function stringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonemptyString);
}
function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validCatalogIdentity(skill: SkillCatalogEntry): boolean {
  return Boolean(
    skill &&
      validIdentifier(skill.id) &&
      nonemptyString(skill.name) &&
      stringList(skill.aliases) &&
      skill.resource &&
      nonemptyString(skill.resource.path),
  );
}

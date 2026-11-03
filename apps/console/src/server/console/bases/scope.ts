// Request scope for Bases: the project (resolved only through
// `findAccessibleProjectRecord`), the base (loaded by the caller organization
// and that project), its properties, and the caller's access.

import { findAccessibleProjectRecord, type ProjectAccessWorkspace } from "@/server/console/project-access";
import type { BaseProperty } from "@/shared/bases/types";

import { baseCapabilities, loadBasesCallerAccess, type BasesCallerAccess } from "./access";
import { createBaseColumnResolver, type BaseCompileContext } from "./compiler";
import { basesCallerViewer, type BasesCaller } from "./context";
import { baseArchived, notFound } from "./errors";
import {
  findBaseRecord,
  loadPropertyRecords,
  type BaseProjectRecord,
  type BaseRecord,
  type BasesExecutor,
} from "./repository";
import { propertyFromRecord } from "./serialize";
import { db } from "@/server/db";
import { assertBasesServiceOperation } from "./service-principal";

export type BasesProjectScope = {
  caller: BasesCaller;
  project: BaseProjectRecord;
  access: BasesCallerAccess;
  /** Project archived: every base in it is read-only. */
  projectReadOnly: boolean;
};

export type BaseScope = BasesProjectScope & {
  base: BaseRecord;
  /** All properties, including soft-deleted ones, in position order. */
  properties: BaseProperty[];
  propertiesById: Map<string, BaseProperty>;
  /** Base or project archived. */
  readOnly: boolean;
  now: Date;
};

/** Workspace shape `findAccessibleProjectRecord` needs, built from a caller. */
export function projectAccessWorkspaceForCaller(caller: BasesCaller): ProjectAccessWorkspace | null {
  if (!caller.user) return null;
  return {
    authorization: caller.authorization,
    user: { id: caller.user.id },
    organization: { id: caller.organizationId },
    membership: { role: caller.orgRole ?? "" },
  };
}

/**
 * Resolves the project with project read access, in the caller organization.
 * Anything else (missing, other organization, deleted) is `404 not_found`.
 */
export async function resolveBasesProject(input: {
  caller: BasesCaller;
  workspace: ProjectAccessWorkspace | null;
  projectRef: string;
  executor?: BasesExecutor;
}): Promise<BasesProjectScope> {
  const workspace = input.workspace ?? projectAccessWorkspaceForCaller(input.caller);
  if (!workspace || workspace.organization.id !== input.caller.organizationId) notFound();
  const ref = input.projectRef.trim();
  if (!ref) notFound();
  const project = await findAccessibleProjectRecord(workspace, ref, "read");
  if (!project || project.organizationId !== input.caller.organizationId || project.status === "deleted") notFound();
  const access = await loadBasesCallerAccess(input.executor ?? db, input.caller, project);
  return { caller: input.caller, project, access, projectReadOnly: project.status !== "active" };
}

/** Loads a base of the project by uuid or slug, with its properties. */
export async function resolveBaseScope(
  projectScope: BasesProjectScope,
  baseRef: string,
  executor: BasesExecutor = db,
): Promise<BaseScope> {
  const base = await findBaseRecord(executor, {
    organizationId: projectScope.caller.organizationId,
    projectId: projectScope.project.id,
    ref: baseRef,
  });
  if (!base || base.organizationId !== projectScope.caller.organizationId) notFound();
  assertBasesServiceOperation({ ...projectScope, base }, "base.resolve");
  // Archived bases are retired for everyone but managers.
  if (base.status !== "active" && !projectScope.access.manage) notFound();
  const records = await loadPropertyRecords(executor, base.id);
  return buildBaseScope(projectScope, base, records.map(propertyFromRecord));
}

export function buildBaseScope(projectScope: BasesProjectScope, base: BaseRecord, properties: BaseProperty[]): BaseScope {
  return {
    ...projectScope,
    base,
    properties,
    propertiesById: new Map(properties.map((property) => [property.id, property])),
    readOnly: projectScope.projectReadOnly || base.status !== "active",
    now: new Date(),
  };
}

export function scopeCapabilities(scope: BasesProjectScope) {
  return baseCapabilities(scope.access);
}

export function activeProperties(scope: BaseScope) {
  return scope.properties.filter((property) => !property.deletedAt);
}

/** Compile context over the base; `allowed` restricts columns (a view projection). */
export function compileContext(scope: BaseScope, options: { allowed?: Iterable<string> | null } = {}): BaseCompileContext {
  return {
    baseId: scope.base.id,
    timezone: scope.base.timezone,
    now: scope.now,
    viewer: basesCallerViewer(scope.caller, scope.base.organizationId),
    resolve: createBaseColumnResolver(scope.properties, { allowed: options.allowed ?? null }),
  };
}

export function assertWritable(scope: BaseScope) {
  if (scope.readOnly) baseArchived();
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { buildCliCommandOperation, commandAccessCandidates } from "../cli/command-access.js";
import { getRegistry } from "../cli/registry-snapshot.js";
import type { CommandRegistryEntry } from "../cli/registry-snapshot.js";
import { listGroupSkillRules } from "../cli/skill-gates.js";
import { getCliToolNames, RUNTIME_BUILTIN_TOOLS } from "../cli/tool-registry.js";
import {
  getConfiguredCapabilityMaterializers,
  getConfiguredPermissionProviders,
} from "../permissions/provider-registry.js";
import { authorizePermission, materializeSubjectCapabilities } from "../permissions/provider-runtime.js";
import type { PermissionProviderRequest } from "../permissions/provider-types.js";
import { dbGetAgent, dbListSkillGrantsForAgent } from "../router/router-db.js";
import type { ContextRecord } from "../router/router-db.js";
import { discoverSkills, listCatalogSkills, listInstalledSkills } from "../skills/manager.js";
import { BASELINE_SYSTEM_SKILL_SLUGS } from "./allowed-skills.js";
import { createRuntimeHostServices } from "./host-services.js";
import { resolveRuntimeContext } from "./context-registry.js";
import { buildSkillPolicyCatalog } from "./skill-policy-catalog.js";
import type { SkillPolicyCatalogSource } from "./skill-policy-catalog.js";
import { resolveSkillPolicy, SkillPolicyError, skillPolicyHash } from "./skill-policy.js";
import type { SkillPolicyDiagnostic, SkillPolicyScope, SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimeCapabilities, RuntimePlugin } from "./types.js";

export type ResolveRuntimeSkillPolicyOptions = {
  readonly agentId: string;
  readonly executionId: string;
  /** Private registry credential; snapshots expose a logical context ID instead. */
  readonly contextKey: string;
  readonly cwd: string;
  readonly context?: ContextRecord;
  readonly plugins: readonly RuntimePlugin[];
  readonly runtimeCapabilities: RuntimeSkillToolSurface;
};

export type RuntimeSkillToolSurface = {
  readonly tools: Pick<RuntimeCapabilities["tools"], "availableCapabilities">;
  readonly dynamicTools: RuntimeCapabilities["dynamicTools"];
};

const skillPolicyContextBindingSchema = z
  .object({
    contractVersion: z.literal(1),
    scope: z
      .object({
        agentId: z.string().trim().min(1),
        executionId: z.string().trim().min(1),
        contextKey: z.string().trim().min(1),
      })
      .strict(),
    cwd: z.string().trim().min(1),
    toolSurface: z
      .object({ availableCapabilities: z.array(z.string().trim().min(1)), dynamicToolsMode: z.enum(["none", "host"]) })
      .strict(),
    plugins: z.array(z.object({ type: z.literal("local"), path: z.string().trim().min(1) }).strict()),
    subjectRevision: z.string().min(1),
  })
  .strict();

export type SkillPolicyContextBinding = z.infer<typeof skillPolicyContextBindingSchema>;

export function buildSkillPolicyContextBinding(input: {
  /** This private binding uses the registry key, never snapshot.scope.contextKey. */
  readonly scope: SkillPolicyScope;
  readonly cwd: string;
  readonly runtimeCapabilities: RuntimeSkillToolSurface;
  readonly plugins?: readonly RuntimePlugin[];
}): SkillPolicyContextBinding {
  return resolvePolicySafely(() => buildContextBinding(input));
}

export function normalizeRuntimeSkillToolSurface(
  runtimeCapabilities: RuntimeSkillToolSurface,
): SkillPolicyContextBinding["toolSurface"] {
  return {
    availableCapabilities: [...new Set(runtimeCapabilities.tools.availableCapabilities ?? [])].sort(),
    dynamicToolsMode: runtimeCapabilities.dynamicTools.mode,
  };
}

function buildContextBinding(input: Parameters<typeof buildSkillPolicyContextBinding>[0]): SkillPolicyContextBinding {
  const parsed = skillPolicyContextBindingSchema.safeParse({
    contractVersion: 1,
    scope: { ...input.scope },
    cwd: input.cwd,
    toolSurface: normalizeRuntimeSkillToolSurface(input.runtimeCapabilities),
    plugins: (input.plugins ?? []).map((plugin) => ({ type: plugin.type, path: plugin.path })),
    subjectRevision: subjectRevision(input.scope.agentId),
  });
  if (!parsed.success) throw new SkillPolicyError("A valid execution scope and declared tool surface are required.");
  return parsed.data;
}

export function resolveManagedSkillPolicyForContext(context: ContextRecord): SkillPolicySnapshot {
  return resolvePolicySafely(() => resolveManagedPolicy(context));
}

function resolveManagedPolicy(context: ContextRecord): SkillPolicySnapshot {
  const current = resolveRuntimeContext(context.contextKey, { touch: false, readOnly: true });
  if (!current || current.contextId !== context.contextId || current.agentId !== context.agentId) {
    throw new SkillPolicyError("Managed skill discovery requires a live registered execution context.");
  }
  const parsed = skillPolicyContextBindingSchema.safeParse(current.metadata?.skillPolicyBinding);
  if (!parsed.success) throw new SkillPolicyError("Managed skill discovery requires a valid tool-surface binding.");
  const binding = parsed.data;
  if (
    binding.scope.agentId !== current.agentId ||
    binding.scope.contextKey !== current.contextKey ||
    binding.subjectRevision !== subjectRevision(binding.scope.agentId)
  ) {
    throw new SkillPolicyError("The skill binding authority is stale; refresh the execution context.");
  }
  return resolveRuntimeSkillPolicy({
    ...binding.scope,
    cwd: binding.cwd,
    context: current,
    plugins: binding.plugins,
    runtimeCapabilities: {
      tools: { availableCapabilities: binding.toolSurface.availableCapabilities },
      dynamicTools: { mode: binding.toolSurface.dynamicToolsMode },
    },
  });
}

function subjectRevision(agentId: string): string {
  return skillPolicyHash({
    capabilities: materializeSubjectCapabilities("agent", agentId),
    providers: permissionProviderVersions(),
  });
}

function authorityRevisionContext(context: ContextRecord) {
  const authorityMetadata = [
    "authorityMode",
    "authorityResolver",
    "executorAgentId",
    "actorPrincipal",
    "actorResolution",
    "actorAuthorizationMode",
    "surfacePrincipal",
    "surfaceAuthorizationMode",
    "agentIdentityPrincipal",
    "agentIdentityCompartment",
    "turnCapabilities",
    "delegationOverridePrincipals",
    "taskSelfTaskId",
  ];
  return {
    agentId: context.agentId,
    kind: context.kind,
    capabilities: context.capabilities,
    source: context.source
      ? {
          channel: context.source.channel,
          accountId: context.source.accountId,
          chatId: context.source.chatId,
          threadId: context.source.threadId,
        }
      : undefined,
    metadata: Object.fromEntries(
      Object.entries(context.metadata ?? {}).filter(([key]) => authorityMetadata.includes(key)),
    ),
  };
}

function effectiveContextKey(context: ContextRecord, cwd: string): string {
  const { capabilities: _capabilities, ...identity } = authorityRevisionContext(context);
  return `context:${skillPolicyHash({
    ...identity,
    sessionKey: context.sessionKey,
    sessionName: context.sessionName,
    workspace: resolve(cwd),
  })}`;
}

export function resolveRuntimeSkillPolicy(input: ResolveRuntimeSkillPolicyOptions): SkillPolicySnapshot {
  return resolvePolicySafely(() => resolveRuntimePolicy(input));
}

function resolvePolicySafely<T>(resolvePolicy: () => T): T {
  try {
    return resolvePolicy();
  } catch (error) {
    if (error instanceof SkillPolicyError) throw error;
    // Catalog/provider exceptions can contain skill text, paths or credential values.
    throw new SkillPolicyError("Runtime identity, permissions or catalog could not be resolved.");
  }
}

function resolveRuntimePolicy(input: ResolveRuntimeSkillPolicyOptions): SkillPolicySnapshot {
  const agentId = input.agentId.trim();
  if (!agentId || !input.executionId.trim() || !input.contextKey.trim() || !input.cwd.trim()) {
    throw new SkillPolicyError("A resolved execution identity is required.");
  }
  const agent = dbGetAgent(agentId);
  if (!agent) throw new SkillPolicyError("The execution agent does not exist.");
  const materialized = materializeSubjectCapabilities("agent", agentId);
  const context: ContextRecord = input.context ?? {
    agentId,
    contextId: input.contextKey,
    contextKey: input.contextKey,
    kind: "agent-runtime",
    capabilities: materialized,
    createdAt: 0,
  };
  if (
    context.agentId !== agentId ||
    context.contextKey !== input.contextKey ||
    context.revokedAt !== undefined ||
    (context.expiresAt !== undefined && context.expiresAt <= Date.now())
  ) {
    throw new SkillPolicyError("The execution context identity is mismatched, revoked or expired.");
  }

  // A denial is a valid answer; a broken provider must not masquerade as an
  // empty permission set when every selected skill happens to be tool-free.
  permitted(context, { permission: "admin", objectType: "system", objectId: "*" });

  const grants = dbListSkillGrantsForAgent(agentId);
  const sources = collectCatalogSources(input);
  const catalog = buildSkillPolicyCatalog(sources);
  const toolSurface = resolveToolSurface(context, input.runtimeCapabilities);
  const groupRules = listGroupSkillRules();
  const derived = groupRules
    .filter((rule) => toolSurface.authorizedGroups.some((group) => rule.pattern.test(group)))
    .map((rule) => rule.skill);
  const localIds = new Set(catalog.entries.filter((entry) => entry.id.startsWith("local:")).map((entry) => entry.id));
  const localGrants = grants.filter((grant) => localIds.has(grant.skillName)).map((grant) => grant.skillName);
  const snapshot = resolveSkillPolicy({
    scope: { agentId, executionId: input.executionId, contextKey: effectiveContextKey(context, input.cwd) },
    revisions: {
      policy: skillPolicyHash({
        version: 1,
        baseline: BASELINE_SYSTEM_SKILL_SLUGS,
        groups: groupRules.map((rule) => ({ id: rule.id, skill: rule.skill, pattern: rule.pattern.source })),
      }),
      catalog: catalog.revision,
      permissions: skillPolicyHash({
        materialized,
        context: authorityRevisionContext(context),
        runtimePermissions: agent.defaults?.runtimePermissions,
        grants: grants.map((grant) => grant.skillName).sort(),
        providers: permissionProviderVersions(),
        authorized: toolSurface.authorized,
      }),
      toolSurface: toolSurface.revision,
    },
    catalog: catalog.entries,
    selection: {
      baseline: BASELINE_SYSTEM_SKILL_SLUGS,
      fromCapabilities: derived,
      fromGrants: grants.map((grant) => grant.skillName),
      local: localGrants,
    },
    capabilityState: toolSurface,
  });
  const diagnostics: SkillPolicyDiagnostic[] = [
    ...catalog.diagnostics,
    ...snapshot.diagnostics,
    { code: agent.defaults?.runtimePermissions === undefined ? "configuration-absent" : "configuration-present" },
    { code: grants.length === 0 ? "grants-empty" : "grants-present" },
  ];
  const unique = new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic]));
  return Object.freeze({
    ...snapshot,
    diagnostics: Object.freeze([...unique.values()].map((diagnostic) => Object.freeze(diagnostic))),
  });
}

function permissionProviderVersions() {
  return [...getConfiguredPermissionProviders(), ...getConfiguredCapabilityMaterializers()].map((provider) => ({
    id: provider.id,
    version: provider.version,
    required: provider.required,
  }));
}

function permitted(
  context: ContextRecord,
  request: Omit<PermissionProviderRequest, "context" | "subject" | "capabilities" | "localOperator">,
): boolean {
  const decision = authorizePermission({ ...request, context });
  if (
    ["provider_error", "no_permission_provider_configured", "required_provider_not_applicable"].includes(
      decision.reasonCode,
    )
  ) {
    throw new SkillPolicyError("The permission provider could not resolve the effective authority.");
  }
  return decision.allowed;
}

function resolveToolSurface(context: ContextRecord, runtime: RuntimeSkillToolSurface) {
  const declared = new Set(runtime.tools.availableCapabilities ?? []);
  const available = new Set<string>();
  const authorized = new Set<string>();
  for (const tool of RUNTIME_BUILTIN_TOOLS) {
    if (!declared.has(tool.capability)) continue;
    available.add(tool.capability);
    if (permitted(context, { permission: "use", objectType: "tool", objectId: tool.nativeName })) {
      authorized.add(tool.capability);
    }
  }
  const shellAvailable = available.has("exec.shell");
  const shellAuthorized =
    authorized.has("exec.shell") &&
    permitted(context, { permission: "execute", objectType: "executable", objectId: "ravi" });
  const hostMode = runtime.dynamicTools.mode === "host";
  const hostTools = hostMode
    ? createRuntimeHostServices({
        context,
        agentId: context.agentId ?? "",
        sessionName: context.sessionName ?? context.contextKey,
        toolContext: {},
      }).listDynamicTools()
    : [];
  const exposedHostTools = new Set(hostTools.map((tool) => tool.name));
  const registeredHostTools = hostMode ? new Set(getCliToolNames()) : new Set<string>();
  const registry = getRegistry();
  const authorizedGroups = new Set<string>();
  const operations: object[] = [];
  for (const command of registry.commands) {
    const toolName = `${command.groupPath.replaceAll(".", "_")}_${command.command}`;
    const hostAvailable = hostMode && registeredHostTools.has(toolName);
    const operationAvailable = shellAvailable || hostAvailable;
    const operationAuthorized =
      operationAvailable &&
      (shellAuthorized || (hostAvailable && exposedHostTools.has(toolName))) &&
      commandPermitted(context, command);
    operations.push({
      name: command.fullName,
      access: command.access,
      scope: command.scope,
      available: operationAvailable,
      hostAvailable,
    });
    if (!operationAvailable) continue;
    available.add(`ravi.cli.${command.fullName}`);
    available.add(`ravi.cli.${command.groupPath}`);
    if (operationAuthorized) {
      authorized.add(`ravi.cli.${command.fullName}`);
      authorized.add(`ravi.cli.${command.groupPath}`);
      authorizedGroups.add(command.groupPath);
    }
  }
  return {
    available: [...available].sort(),
    authorized: [...authorized].sort(),
    authorizedGroups: [...authorizedGroups].sort(),
    revision: skillPolicyHash({ declared: [...declared].sort(), dynamicTools: runtime.dynamicTools, operations }),
  };
}

function commandPermitted(context: ContextRecord, command: CommandRegistryEntry): boolean {
  if (!command.access) return false;
  if (
    command.scope === "superadmin" &&
    !permitted(context, { permission: "admin", objectType: "system", objectId: "*" })
  )
    return false;
  const input = {
    group: command.groupPath.replaceAll(".", "_"),
    command: command.command,
    access: command.access,
    source: "tool",
  } satisfies Parameters<typeof buildCliCommandOperation>[0];
  const operation = buildCliCommandOperation(input);
  return commandAccessCandidates(input).some((candidate) => permitted(context, { ...candidate, operation }));
}

/** Discovery reads source metadata only; no plugin or skill is materialized here. */
function collectCatalogSources(input: ResolveRuntimeSkillPolicyOptions): SkillPolicyCatalogSource[] {
  const sources: SkillPolicyCatalogSource[] = [...listCatalogSkills(), ...listInstalledSkills({ includeCodex: false })];
  for (const plugin of input.plugins) {
    const manifest: unknown = JSON.parse(readFileSync(join(plugin.path, ".claude-plugin", "plugin.json"), "utf8"));
    if (!isRecord(manifest) || typeof manifest.name !== "string" || !manifest.name.trim()) {
      throw new SkillPolicyError("A source plugin has no valid identity.");
    }
    sources.push(...readSkillDirectory(join(plugin.path, "skills"), `plugin:${manifest.name}`, manifest.name));
  }
  for (const directory of [".agents", ".claude", ".codex"]) {
    sources.push(...readSkillDirectory(join(input.cwd, directory, "skills"), `local:workspace:${directory.slice(1)}`));
  }
  // Reading the same file twice via installed and explicit plugin discovery is
  // not an identity conflict. Distinct resources retain separate candidates.
  const unique = new Map<string, SkillPolicyCatalogSource>();
  for (const source of sources) {
    const key = source.source.startsWith("catalog:") ? source.source : resolve(source.skillFilePath);
    const previous = unique.get(key);
    if (previous && (previous.name !== source.name || previous.pluginName !== source.pluginName)) {
      throw new SkillPolicyError("A catalog resource has conflicting identities.");
    }
    unique.set(key, source);
  }
  return [...unique.values()].map((source) =>
    source.files
      ? source
      : {
          ...source,
          resourceRevision: fingerprintSkillResources(source.path),
        },
  );
}

function fingerprintSkillResources(root: string): string {
  const files = readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  return skillPolicyHash(
    files.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) return { name: entry.name, kind: "symlink" };
      if (entry.isDirectory()) return { name: entry.name, directory: fingerprintSkillResources(path) };
      if (!entry.isFile()) return { name: entry.name, kind: "unsupported" };
      return { name: entry.name, digest: createHash("sha256").update(readFileSync(path)).digest("hex") };
    }),
  );
}

function readSkillDirectory(root: string, source: string, pluginName?: string): SkillPolicyCatalogSource[] {
  if (!existsSync(root)) return [];
  const sources: SkillPolicyCatalogSource[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const skillFilePath = join(path, "SKILL.md");
    if (!existsSync(skillFilePath)) continue;
    for (const skill of discoverSkills({ source: { type: "local", input: source }, rootPath: path })) {
      sources.push({ ...skill, ...(pluginName ? { pluginName } : {}) });
    }
  }
  return sources;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

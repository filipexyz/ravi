import { resolve as resolvePath } from "node:path";
import { ConsoleApiClient, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import { DEFAULT_CONSOLE_URL, type CloudCredentials } from "../cloud-auth/types.js";
import { listCloudProjects, type CloudProjectListResult, type CloudProjectPayload } from "../cloud-projects/client.js";
import { getContext, type ToolContext } from "../cli/context.js";
import {
  getConsoleScopeDefault,
  listConsoleScopeDefaultsForTargets,
  normalizeConsoleScopeTarget,
  normalizeWorkspaceScopeKey,
  upsertConsoleScopeDefault,
  deleteConsoleScopeDefault,
  type UpsertConsoleScopeDefaultInput,
} from "./store.js";
import {
  type ConsoleScopeCandidate,
  type ConsoleScopeDefault,
  type ConsoleScopeExplanation,
  type ConsoleScopeKind,
  type ConsoleScopeOrganization,
  type ConsoleScopeProject,
  type ConsoleScopeSource,
  type ConsoleScopeTarget,
  type ResolvedConsoleScope,
} from "./types.js";

export interface ConsoleScopeResolverDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
  listProjects?: typeof listCloudProjects;
  getContext?: typeof getContext;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ResolveConsoleScopeInput {
  consoleUrl?: string;
  explicitProject?: string | null;
  requireProject?: boolean;
}

export interface SaveConsoleScopeDefaultInput extends Omit<UpsertConsoleScopeDefaultInput, "consoleUrl"> {
  consoleUrl?: string;
}

export async function resolveConsoleScope(
  input: ResolveConsoleScopeInput = {},
  deps: ConsoleScopeResolverDeps = {},
): Promise<ResolvedConsoleScope> {
  const explanation = await explainConsoleScope(input, deps);
  if (input.requireProject && !explanation.resolved?.project?.ref) {
    throw missingProjectError(explanation);
  }
  if (explanation.resolved) return explanation.resolved;

  return {
    consoleUrl: explanation.consoleUrl,
    organization: explanation.organization,
    project: null,
    source: "cloud_credentials",
  };
}

export async function resolveConsoleProjectRef(
  input: ResolveConsoleScopeInput = {},
  deps: ConsoleScopeResolverDeps = {},
): Promise<{ projectRef: string; scope: ResolvedConsoleScope }> {
  const scope = await resolveConsoleScope({ ...input, requireProject: true }, deps);
  const projectRef = scope.project?.ref;
  if (!projectRef) throw missingProjectError(await explainConsoleScope(input, deps));
  return { projectRef, scope };
}

export async function explainConsoleScope(
  input: ResolveConsoleScopeInput = {},
  deps: ConsoleScopeResolverDeps = {},
): Promise<ConsoleScopeExplanation> {
  const env = deps.env ?? process.env;
  const context = (deps.getContext ?? getContext)();
  const credentials = readCredentialsForConsole(input.consoleUrl, deps);
  const consoleUrl = normalizeConsoleUrl(
    input.consoleUrl ?? credentials?.consoleUrl ?? env.RAVI_CONSOLE_URL ?? DEFAULT_CONSOLE_URL,
  );
  const organization = organizationFromCredentials(credentials, env);
  const candidates: ConsoleScopeCandidate[] = [];

  const explicitProject = text(input.explicitProject);
  if (explicitProject) {
    const resolved = scopeFromProject({
      consoleUrl,
      organization,
      project: projectFromRef(explicitProject),
      source: "explicit",
    });
    candidates.push(candidateFromScope(resolved, "Explicit CLI project", true));
    return {
      success: true,
      consoleUrl,
      organization,
      resolved,
      candidates,
      missingProjectCommand: null,
    };
  }
  candidates.push({
    source: "explicit",
    label: "Explicit CLI project",
    selected: false,
    available: false,
    reason: "No --project or project argument was provided.",
  });

  const runtimeScope = scopeFromRuntimeContext(context, consoleUrl, organization);
  if (runtimeScope?.project?.ref) {
    candidates.push(candidateFromScope(runtimeScope, "Runtime context metadata", true));
    return explanationFromResolved(consoleUrl, organization, runtimeScope, candidates);
  }
  candidates.push({
    source: "runtime_context",
    label: "Runtime context metadata",
    selected: false,
    available: false,
    reason: "No metadata.consoleScope project was found in RAVI_CONTEXT_KEY.",
  });

  const envScope = scopeFromProjectedEnv(env, consoleUrl, organization);
  if (envScope?.project?.ref) {
    candidates.push(candidateFromScope(envScope, "Runtime env projection", true));
    return explanationFromResolved(consoleUrl, organization, envScope, candidates);
  }
  candidates.push({
    source: "env_compat",
    label: "Runtime env projection",
    selected: false,
    available: false,
    reason: "No RAVI_CONSOLE_PROJECT_REF or RAVI_CONSOLE_PROJECT_ID was provided.",
  });

  candidates.push({
    source: "local_project_mapping",
    label: "Local Project Console mapping",
    selected: false,
    available: false,
    reason: "No explicit local Project -> Console project mapping is attached to this runtime context.",
  });

  for (const target of scopeTargets(context, deps)) {
    const saved = getConsoleScopeDefault(target, consoleUrl, { env, organization });
    const source = sourceForTarget(target.scopeKind);
    if (!saved?.project?.ref) {
      candidates.push({
        source,
        label: labelForTarget(target),
        scopeKind: target.scopeKind,
        scopeKey: target.scopeKey,
        selected: false,
        available: false,
        reason: "No saved default for this scope.",
      });
      continue;
    }
    const resolved = scopeFromProject({
      consoleUrl,
      organization: saved.organization ?? organization,
      project: saved.project,
      source,
    });
    candidates.push({
      ...candidateFromScope(resolved, labelForTarget(target), true),
      scopeKind: target.scopeKind,
      scopeKey: target.scopeKey,
    });
    return explanationFromResolved(consoleUrl, organization, resolved, candidates);
  }

  const raviProject = text(env.RAVI_PROJECT);
  if (raviProject) {
    const resolved = scopeFromProject({
      consoleUrl,
      organization,
      project: projectFromRef(raviProject),
      source: "env_compat",
    });
    candidates.push(candidateFromScope(resolved, "RAVI_PROJECT compatibility", true));
    return explanationFromResolved(consoleUrl, organization, resolved, candidates);
  }
  candidates.push({
    source: "env_compat",
    label: "RAVI_PROJECT compatibility",
    selected: false,
    available: false,
    reason: "RAVI_PROJECT is not set.",
  });

  if (credentials) {
    candidates.push({
      source: "cloud_credentials",
      label: "Cloud credentials organization",
      consoleUrl,
      organization,
      selected: false,
      available: true,
      reason: "Credentials select organization only; no project default is stored.",
    });
  } else {
    candidates.push({
      source: "cloud_credentials",
      label: "Cloud credentials organization",
      consoleUrl,
      selected: false,
      available: false,
      reason: "No Ravi Cloud credentials are stored locally.",
    });
  }

  const remoteProjects = await visibleRemoteProjects(credentials, input.consoleUrl, deps);
  if (remoteProjects.length === 1) {
    const resolved = scopeFromProject({
      consoleUrl,
      organization,
      project: remoteProjects[0],
      source: "single_remote_project",
    });
    candidates.push(candidateFromScope(resolved, "Single visible Console project", true));
    return explanationFromResolved(consoleUrl, organization, resolved, candidates);
  }
  if (remoteProjects.length > 1) {
    candidates.push({
      source: "single_remote_project",
      label: "Single visible Console project",
      consoleUrl,
      organization,
      selected: false,
      available: false,
      reason: `Multiple visible Console projects; set one explicitly. Visible refs: ${remoteProjects
        .map((project) => project.ref)
        .join(", ")}.`,
    });
  }

  return {
    success: true,
    consoleUrl,
    organization,
    resolved: credentials
      ? {
          consoleUrl,
          organization,
          project: null,
          source: "cloud_credentials",
        }
      : null,
    candidates,
    missingProjectCommand: missingProjectCommand(context, deps),
  };
}

export async function saveConsoleScopeDefault(
  input: SaveConsoleScopeDefaultInput,
  deps: ConsoleScopeResolverDeps = {},
): Promise<ConsoleScopeDefault> {
  const env = deps.env ?? process.env;
  const credentials = readCredentialsForConsole(input.consoleUrl, deps);
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  const consoleUrl = normalizeConsoleUrl(input.consoleUrl ?? credentials.consoleUrl);
  const project = await validateProjectRef(input.project?.ref, consoleUrl, deps);
  return upsertConsoleScopeDefault(
    {
      ...input,
      consoleUrl,
      organization: input.organization ?? credentials.organization ?? null,
      project,
    },
    { env, organization: input.organization ?? credentials.organization ?? null },
  );
}

export function clearConsoleScopeDefault(
  target: ConsoleScopeTarget,
  consoleUrl: string | undefined,
  deps: ConsoleScopeResolverDeps = {},
): boolean {
  const env = deps.env ?? process.env;
  const credentials = readCredentialsForConsole(consoleUrl, deps);
  const normalizedConsole = normalizeConsoleUrl(
    consoleUrl ?? credentials?.consoleUrl ?? env.RAVI_CONSOLE_URL ?? DEFAULT_CONSOLE_URL,
  );
  return deleteConsoleScopeDefault(normalizeConsoleScopeTarget(target), normalizedConsole, {
    env,
    organization: credentials?.organization ?? organizationFromCredentials(credentials, env),
  });
}

export async function validateProjectRef(
  projectRef: string | null | undefined,
  consoleUrl: string | undefined,
  deps: ConsoleScopeResolverDeps = {},
): Promise<ConsoleScopeProject> {
  const ref = text(projectRef);
  if (!ref) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --project.");
  const projects = await (deps.listProjects ?? listCloudProjects)(
    { console: consoleUrl },
    {
      client: deps.client,
      readCredentials: deps.readCredentials,
      writeCredentials: deps.writeCredentials,
      deleteCredentials: deps.deleteCredentials,
    },
  );
  const match = projects.projects.map(projectFromPayload).find((project) => projectMatchesRef(project, ref));
  if (!match) {
    const knownRefs = projects.projects
      .map(projectFromPayload)
      .map((project) => project.ref)
      .filter(Boolean)
      .join(", ");
    throw new CloudAuthError(
      "PROJECT_ACCESS_DENIED",
      `Console project "${ref}" is not visible in the selected organization.${
        knownRefs ? ` Visible project refs: ${knownRefs}.` : ""
      }`,
    );
  }
  return match;
}

export function scopeTargets(
  context: ToolContext | undefined,
  deps: ConsoleScopeResolverDeps = {},
): ConsoleScopeTarget[] {
  const cwd = normalizeWorkspaceScopeKey(deps.cwd ?? process.cwd());
  const targets: ConsoleScopeTarget[] = [];
  const sessionKey = text(context?.sessionKey);
  const sessionName = text(context?.sessionName);
  const agentId = text(context?.agentId);
  if (sessionKey) targets.push({ scopeKind: "session", scopeKey: sessionKey });
  if (sessionName && sessionName !== sessionKey) targets.push({ scopeKind: "session", scopeKey: sessionName });
  if (agentId) targets.push({ scopeKind: "agent", scopeKey: agentId });
  targets.push({ scopeKind: "workspace", scopeKey: cwd });
  targets.push({ scopeKind: "global", scopeKey: "default" });
  return targets;
}

export function defaultScopeTarget(
  input: Partial<Record<ConsoleScopeKind, string | boolean | undefined>>,
  deps: ConsoleScopeResolverDeps = {},
): ConsoleScopeTarget {
  const provided = Object.entries(input).filter(([, value]) => value !== undefined && value !== false);
  if (provided.length > 1) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Choose only one scope target: --session, --agent, --workspace, or --global.",
    );
  }
  if (input.session !== undefined && input.session !== false) {
    return { scopeKind: "session", scopeKey: optionValueOrDefault(input.session, currentSessionKey(deps)) };
  }
  if (input.agent !== undefined && input.agent !== false) {
    return { scopeKind: "agent", scopeKey: optionValueOrDefault(input.agent, currentContext(deps)?.agentId ?? null) };
  }
  if (input.workspace !== undefined && input.workspace !== false) {
    return {
      scopeKind: "workspace",
      scopeKey: normalizeWorkspaceScopeKey(optionValueOrDefault(input.workspace, deps.cwd ?? process.cwd())),
    };
  }
  if (input.global !== undefined && input.global !== false) {
    return { scopeKind: "global", scopeKey: "default" };
  }

  const context = currentContext(deps);
  const session = currentSessionKey(deps);
  if (session) return { scopeKind: "session", scopeKey: session };
  if (context?.agentId) return { scopeKind: "agent", scopeKey: context.agentId };
  return { scopeKind: "workspace", scopeKey: normalizeWorkspaceScopeKey(deps.cwd ?? process.cwd()) };
}

export function savedDefaultsForCurrentContext(
  consoleUrl: string | undefined,
  deps: ConsoleScopeResolverDeps = {},
): ConsoleScopeDefault[] {
  const credentials = readCredentialsForConsole(consoleUrl, deps);
  const normalizedConsole = normalizeConsoleUrl(consoleUrl ?? credentials?.consoleUrl ?? DEFAULT_CONSOLE_URL);
  const organization = organizationFromCredentials(credentials, deps.env ?? process.env);
  return listConsoleScopeDefaultsForTargets(scopeTargets(currentContext(deps), deps), normalizedConsole, {
    env: deps.env ?? process.env,
    organization,
  });
}

function readCredentialsForConsole(
  consoleUrl: string | undefined,
  deps: ConsoleScopeResolverDeps,
): CloudCredentials | null {
  const credentials = (deps.readCredentials ?? readCloudCredentials)(deps.env ?? process.env);
  if (!credentials) return null;
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalizeConsoleUrl(consoleUrl)}. Run \`ravi login --console ${normalizeConsoleUrl(
        consoleUrl,
      )}\`.`,
    );
  }
  return credentials;
}

function currentContext(deps: ConsoleScopeResolverDeps): ToolContext | undefined {
  return (deps.getContext ?? getContext)();
}

function currentSessionKey(deps: ConsoleScopeResolverDeps): string | null {
  const context = currentContext(deps);
  return text(context?.sessionKey) ?? text(context?.sessionName);
}

function organizationFromCredentials(
  credentials: CloudCredentials | null,
  env: NodeJS.ProcessEnv,
): ConsoleScopeOrganization | null {
  const organization = credentials?.organization;
  if (organization) return organization;
  if (text(env.RAVI_CONSOLE_ORG_ID) || text(env.RAVI_CONSOLE_ORG_SLUG)) {
    return {
      id: text(env.RAVI_CONSOLE_ORG_ID),
      slug: text(env.RAVI_CONSOLE_ORG_SLUG),
      name: null,
    };
  }
  return null;
}

function scopeFromRuntimeContext(
  context: ToolContext | undefined,
  consoleUrl: string,
  fallbackOrganization: ConsoleScopeOrganization | null,
): ResolvedConsoleScope | null {
  const metadata = context?.context?.metadata;
  const rawScope = objectValue(metadata?.consoleScope);
  if (!rawScope) return null;
  const project = projectFromUnknown(rawScope.project);
  const organization = organizationFromUnknown(rawScope.organization) ?? fallbackOrganization;
  const rawConsole = text(rawScope.consoleUrl) ?? consoleUrl;
  if (!project?.ref) return null;
  return scopeFromProject({
    consoleUrl: normalizeConsoleUrl(rawConsole),
    organization,
    project,
    source: "runtime_context",
  });
}

function scopeFromProjectedEnv(
  env: NodeJS.ProcessEnv,
  consoleUrl: string,
  organization: ConsoleScopeOrganization | null,
): ResolvedConsoleScope | null {
  const projectRef = text(env.RAVI_CONSOLE_PROJECT_REF) ?? text(env.RAVI_CONSOLE_PROJECT_ID);
  if (!projectRef) return null;
  return scopeFromProject({
    consoleUrl,
    organization,
    project: {
      id: text(env.RAVI_CONSOLE_PROJECT_ID),
      slug: text(env.RAVI_CONSOLE_PROJECT_REF),
      name: null,
      ref: projectRef,
    },
    source: "env_compat",
  });
}

async function visibleRemoteProjects(
  credentials: CloudCredentials | null,
  consoleUrl: string | undefined,
  deps: ConsoleScopeResolverDeps,
): Promise<ConsoleScopeProject[]> {
  if (!credentials) return [];
  let result: CloudProjectListResult;
  try {
    result = await (deps.listProjects ?? listCloudProjects)(
      { console: consoleUrl },
      {
        client: deps.client,
        readCredentials: deps.readCredentials,
        writeCredentials: deps.writeCredentials,
        deleteCredentials: deps.deleteCredentials,
      },
    );
  } catch {
    return [];
  }
  return result.projects.map(projectFromPayload);
}

function explanationFromResolved(
  consoleUrl: string,
  organization: ConsoleScopeOrganization | null,
  resolved: ResolvedConsoleScope,
  candidates: ConsoleScopeCandidate[],
): ConsoleScopeExplanation {
  return {
    success: true,
    consoleUrl,
    organization,
    resolved,
    candidates,
    missingProjectCommand: null,
  };
}

function missingProjectError(explanation: ConsoleScopeExplanation): CloudAuthError {
  const visibleProjects = explanation.candidates
    .filter((candidate) => candidate.source === "single_remote_project" && candidate.project?.ref)
    .map((candidate) => candidate.project?.ref)
    .filter(Boolean)
    .join(", ");
  const next = explanation.missingProjectCommand ?? "ravi cloud scope set --project <project-ref>";
  const remoteProjectReason = explanation.candidates.find(
    (candidate) => candidate.source === "single_remote_project",
  )?.reason;
  return new CloudAuthError(
    "PAYLOAD_INVALID",
    `Missing Console project. Set one with:\n  ${next}\nor pass --project <project-ref>.${
      visibleProjects ? `\nVisible project refs: ${visibleProjects}.` : ""
    }${remoteProjectReason ? `\n${remoteProjectReason}` : ""}`,
  );
}

function missingProjectCommand(context: ToolContext | undefined, deps: ConsoleScopeResolverDeps): string {
  const session = text(context?.sessionName) ?? text(context?.sessionKey);
  if (session) return `ravi cloud scope set --project <project-ref> --session ${shellWord(session)}`;
  return `ravi cloud scope set --project <project-ref> --workspace ${shellWord(resolvePath(deps.cwd ?? process.cwd()))}`;
}

function scopeFromProject(input: {
  consoleUrl: string;
  organization: ConsoleScopeOrganization | null;
  project: ConsoleScopeProject;
  source: ConsoleScopeSource;
}): ResolvedConsoleScope {
  return {
    consoleUrl: input.consoleUrl,
    organization: input.organization,
    project: input.project,
    source: input.source,
  };
}

function candidateFromScope(scope: ResolvedConsoleScope, label: string, selected: boolean): ConsoleScopeCandidate {
  return {
    source: scope.source,
    label,
    consoleUrl: scope.consoleUrl,
    organization: scope.organization,
    project: scope.project,
    selected,
    available: !!scope.project?.ref || scope.source === "cloud_credentials",
  };
}

function sourceForTarget(kind: ConsoleScopeKind): ConsoleScopeSource {
  switch (kind) {
    case "session":
      return "session_default";
    case "agent":
      return "agent_default";
    case "workspace":
      return "workspace_default";
    case "global":
      return "global_default";
  }
}

function labelForTarget(target: ConsoleScopeTarget): string {
  switch (target.scopeKind) {
    case "session":
      return `Session default (${target.scopeKey})`;
    case "agent":
      return `Agent default (${target.scopeKey})`;
    case "workspace":
      return `Workspace default (${target.scopeKey})`;
    case "global":
      return "Global default";
  }
}

function projectFromRef(ref: string): ConsoleScopeProject {
  return {
    id: null,
    slug: ref,
    name: null,
    ref,
  };
}

function projectFromPayload(payload: CloudProjectPayload): ConsoleScopeProject {
  const id = text(payload.id);
  const slug = text(payload.slug);
  const name = text(payload.name);
  return {
    id,
    slug,
    name,
    ref: slug ?? id ?? name ?? "project",
  };
}

function projectFromUnknown(value: unknown): ConsoleScopeProject | null {
  const record = objectValue(value);
  if (!record) return null;
  const ref = text(record.ref) ?? text(record.slug) ?? text(record.id) ?? text(record.name);
  if (!ref) return null;
  return {
    id: text(record.id),
    slug: text(record.slug),
    name: text(record.name),
    ref,
  };
}

function organizationFromUnknown(value: unknown): ConsoleScopeOrganization | null {
  const record = objectValue(value);
  if (!record) return null;
  if (!text(record.id) && !text(record.slug) && !text(record.name)) return null;
  return {
    id: text(record.id),
    slug: text(record.slug),
    name: text(record.name),
  };
}

function projectMatchesRef(project: ConsoleScopeProject, ref: string): boolean {
  return project.ref === ref || project.id === ref || project.slug === ref;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionValueOrDefault(value: string | boolean | undefined, fallback: string | null): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value === true && fallback) return fallback;
  if (value === undefined && fallback) return fallback;
  return "";
}

function shellWord(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

import "reflect-metadata";
import { z } from "zod";
import { Command, CommandAccess, Group, Option } from "../decorators.js";
import { CloudAuthError, cloudAuthErrorFromUnknown, formatCloudAuthError } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../../cloud-auth/storage.js";
import {
  clearConsoleScopeDefault,
  defaultScopeTarget,
  explainConsoleScope,
  resolveConsoleScope,
  saveConsoleScopeDefault,
  type ConsoleScopeResolverDeps,
} from "../../console-scope/resolver.js";
import type {
  ConsoleScopeDefault,
  ConsoleScopeExplanation,
  ConsoleScopeTarget,
  ResolvedConsoleScope,
} from "../../console-scope/types.js";
import { CONSOLE_SCOPE_KINDS } from "../../console-scope/types.js";
import { hasContext } from "../context.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

export interface CloudScopeCommandDeps extends ConsoleScopeResolverDeps {
  client?: ConsoleApiClient;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

@Group({
  name: "cloud.scope",
  description: "Inspect and set Ravi Console organization/project defaults for local commands",
  scope: "open",
})
export class CloudScopeCommands {
  constructor(private readonly deps: CloudScopeCommandDeps = defaultCloudScopeDeps()) {}

  @Command({ name: "show", description: "Show the effective Ravi Console scope for this process" })
  @CommandAccess({ kind: "read", resource: "cloud.scope", action: "show", risk: "low" })
  async show(
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCloudScopeCommand(asJson, async () => {
      const scope = await resolveConsoleScope({ consoleUrl }, this.deps);
      const payload = { success: true as const, scope };
      printPayload(payload, asJson, () => printScope(scope));
      return payload;
    });
  }

  @Command({ name: "explain", description: "Explain how the effective Ravi Console scope is resolved" })
  @CommandAccess({ kind: "read", resource: "cloud.scope", action: "explain", risk: "low" })
  async explain(
    @Option({ flags: "--project <ref>", description: "Pretend this explicit project was passed" }) projectRef?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCloudScopeCommand(asJson, async () => {
      const payload = await explainConsoleScope({ consoleUrl, explicitProject: projectRef }, this.deps);
      printPayload(payload, asJson, () => printExplanation(payload));
      return payload;
    });
  }

  @Command({ name: "set", description: "Set a default Console project for a session, agent, workspace, or install" })
  @CommandAccess({ kind: "mutate", resource: "cloud.scope", action: "set", risk: "medium" })
  async set(
    @Option({ flags: "--project <ref>", description: "Console project id or slug to use by default" })
    projectRef?: string,
    @Option({
      flags: "--session [session]",
      description: "Set default for a Ravi session; current session when omitted",
    })
    session?: string | boolean,
    @Option({ flags: "--agent [agent]", description: "Set default for an agent; current agent when omitted" })
    agent?: string | boolean,
    @Option({ flags: "--workspace [path]", description: "Set default for a workspace; current cwd when omitted" })
    workspace?: string | boolean,
    @Option({ flags: "--global", description: "Set default for this local Ravi installation" }) global?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCloudScopeCommand(asJson, async () => {
      const target = defaultScopeTarget({ session, agent, workspace, global }, this.deps);
      const saved = await saveConsoleScopeDefault(
        {
          ...target,
          consoleUrl,
          project: {
            ref: requiredText(projectRef, "--project"),
          },
          sourceNote: "ravi cloud scope set",
        },
        this.deps,
      );
      const payload = scopeMutationPayload("set", target, saved);
      printPayload(payload, asJson, () => printSavedDefault(payload.scope));
      return payload;
    });
  }

  @Command({
    name: "clear",
    description: "Clear a default Console project for a session, agent, workspace, or install",
  })
  @CommandAccess({ kind: "mutate", resource: "cloud.scope", action: "clear", risk: "medium" })
  async clear(
    @Option({
      flags: "--session [session]",
      description: "Clear default for a Ravi session; current session when omitted",
    })
    session?: string | boolean,
    @Option({ flags: "--agent [agent]", description: "Clear default for an agent; current agent when omitted" })
    agent?: string | boolean,
    @Option({ flags: "--workspace [path]", description: "Clear default for a workspace; current cwd when omitted" })
    workspace?: string | boolean,
    @Option({ flags: "--global", description: "Clear default for this local Ravi installation" }) global?: boolean,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runCloudScopeCommand(asJson, async () => {
      const target = defaultScopeTarget({ session, agent, workspace, global }, this.deps);
      const cleared = clearConsoleScopeDefault(target, consoleUrl, this.deps);
      const payload = { success: true as const, action: "clear" as const, target, cleared };
      printPayload(payload, asJson, () => {
        console.log(cleared ? "✓ Console scope default cleared" : "No Console scope default existed for that target.");
        printTarget(target);
      });
      return payload;
    });
  }
}

function defaultCloudScopeDeps(): CloudScopeCommandDeps {
  return {};
}

const consoleScopeSourceSchema = z.enum([
  "explicit",
  "runtime_context",
  "local_project_mapping",
  "session_default",
  "agent_default",
  "workspace_default",
  "global_default",
  "cloud_credentials",
  "env_compat",
  "single_remote_project",
]);
const consoleScopeOrganizationSchema = z.object({
  id: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
});
const consoleScopeProjectSchema = z.object({
  id: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  ref: z.string(),
});
const consoleScopeSchema = z.object({
  consoleUrl: z.string(),
  organization: consoleScopeOrganizationSchema.nullable().optional(),
  project: consoleScopeProjectSchema.nullable().optional(),
  source: consoleScopeSourceSchema,
});
const consoleScopeTargetSchema = z.object({
  scopeKind: z.enum(CONSOLE_SCOPE_KINDS),
  scopeKey: z.string(),
});
const consoleScopeExplanationSchema = z.object({
  success: z.literal(true),
  consoleUrl: z.string(),
  organization: consoleScopeOrganizationSchema.nullable().optional(),
  resolved: consoleScopeSchema.nullable(),
  candidates: z.array(
    z.object({
      source: consoleScopeSourceSchema,
      label: z.string(),
      scopeKind: z.enum(CONSOLE_SCOPE_KINDS).optional(),
      scopeKey: z.string().optional(),
      consoleUrl: z.string().optional(),
      organization: consoleScopeOrganizationSchema.nullable().optional(),
      project: consoleScopeProjectSchema.nullable().optional(),
      selected: z.boolean(),
      available: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  missingProjectCommand: z.string().nullable().optional(),
});

declareCommandReturns(CloudScopeCommands, {
  show: z.object({
    success: z.literal(true),
    scope: consoleScopeSchema,
  }),
  explain: consoleScopeExplanationSchema,
  set: z.object({
    success: z.literal(true),
    action: z.literal("set"),
    target: consoleScopeTargetSchema,
    scope: consoleScopeSchema,
  }),
  clear: z.object({
    success: z.literal(true),
    action: z.literal("clear"),
    target: consoleScopeTargetSchema,
    cleared: z.boolean(),
  }),
});

async function runCloudScopeCommand<T>(asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const cloudError = cloudAuthErrorFromUnknown(error);
    if (asJson) {
      printJson(formatCloudAuthError(cloudError));
    } else {
      console.error(`${cloudError.code}: ${cloudError.message}`);
      if (cloudError.code === "AUTH_REQUIRED" || cloudError.code === "AUTH_EXPIRED") {
        console.error("Next: run `ravi login`.");
      }
    }
    if (hasContext()) throw cloudError;
    process.exit(cloudError.exitCode);
  }
}

function scopeMutationPayload(action: "set", target: ConsoleScopeTarget, scope: ConsoleScopeDefault) {
  return {
    success: true as const,
    action,
    target,
    scope,
  };
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    printJson(payload);
    return;
  }
  printHuman();
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printScope(scope: ResolvedConsoleScope): void {
  console.log("Ravi Console scope");
  console.log(`  Console:  ${scope.consoleUrl}`);
  console.log(`  Source:   ${scope.source}`);
  if (scope.organization) {
    console.log(
      `  Org:      ${scope.organization.slug ?? scope.organization.id ?? scope.organization.name ?? "selected"}`,
    );
  }
  if (scope.project) {
    console.log(`  Project:  ${scope.project.ref}`);
  } else {
    console.log("  Project:  not selected");
  }
}

function printExplanation(payload: ConsoleScopeExplanation): void {
  console.log("Ravi Console scope resolution");
  console.log(`  Console:  ${payload.consoleUrl}`);
  if (payload.organization) {
    console.log(
      `  Org:      ${payload.organization.slug ?? payload.organization.id ?? payload.organization.name ?? "selected"}`,
    );
  }
  for (const candidate of payload.candidates) {
    const mark = candidate.selected ? "✓" : candidate.available ? "-" : "×";
    const detail = candidate.project?.ref
      ? ` project=${candidate.project.ref}`
      : candidate.reason
        ? ` ${candidate.reason}`
        : "";
    console.log(`  ${mark} ${candidate.label}${detail}`);
  }
  if (payload.resolved?.project?.ref) {
    console.log(`  Selected: ${payload.resolved.project.ref} (${payload.resolved.source})`);
  } else if (payload.missingProjectCommand) {
    console.log("  Next:");
    console.log(`    ${payload.missingProjectCommand}`);
  }
}

function printSavedDefault(scope: ConsoleScopeDefault): void {
  console.log("✓ Console scope default saved");
  printTarget(scope);
  console.log(`  Console:  ${scope.consoleUrl}`);
  if (scope.organization) {
    console.log(
      `  Org:      ${scope.organization.slug ?? scope.organization.id ?? scope.organization.name ?? "selected"}`,
    );
  }
  if (scope.project) {
    console.log(`  Project:  ${scope.project.ref}`);
  }
}

function printTarget(target: Pick<ConsoleScopeDefault, "scopeKind" | "scopeKey">): void {
  console.log(`  Scope:    ${target.scopeKind}:${target.scopeKey}`);
}

function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${label}.`);
  return text;
}

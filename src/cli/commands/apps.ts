import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  buildAppsGuide,
  checkAppManifests,
  discoverAppManifests,
  getAppManifest,
  importCliApp,
  normalizeAppSource,
  scaffoldApp,
  printAppRunResult,
  runAppOperation,
  assertCanUseApp,
  filterVisibleAppChecks,
  filterVisibleAppManifests,
  type RaviAppManifestRecord,
} from "../../apps/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const appPermissionProviderSchemaSummarySchema = z.object({
  kind: z.enum(["ref", "inline", "unknown"]),
  ref: z.string().nullable(),
  schema: z.string().nullable(),
  type: z.string().nullable(),
});

const appPermissionProviderSchema = z.object({
  id: z.string(),
  version: z.string(),
  interface: z.enum(["builtin", "cli", "sdk", "tool"]),
  operation: z.string(),
  decisionSchema: appPermissionProviderSchemaSummarySchema,
  requestSchema: appPermissionProviderSchemaSummarySchema,
  timeoutMs: z.number().optional(),
  cacheTtlSec: z.number().optional(),
  failClosed: z.literal(true),
  scope: z.array(z.string()).optional(),
});

const appPermissionsSchema = z.object({
  required: z.array(z.string()),
  optional: z.array(z.string()),
  mutating: z.array(z.string()),
  provider: appPermissionProviderSchema.nullable(),
});

const appSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  schema: z.string().nullable(),
  source: z.enum(["repo", "plugin", "state"]),
  path: z.string(),
  relativePath: z.string(),
  rootPath: z.string(),
  interfaceNames: z.array(z.string()),
  permissions: appPermissionsSchema,
  valid: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

const appDetailSchema = appSummarySchema.extend({
  manifest: z.unknown().nullable(),
});

const paginationSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  nextCommand: z.string().nullable(),
});

const appCheckResultSchema = z.object({
  id: z.string(),
  path: z.string(),
  source: z.enum(["repo", "plugin", "state"]),
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});

const appsListReturnSchema = z.object({
  total: z.number(),
  pagination: paginationSchema,
  items: z.array(appSummarySchema),
  apps: z.array(appSummarySchema),
});

const appsShowReturnSchema = z.object({
  app: appDetailSchema,
});

const appsCheckReturnSchema = z.object({
  ok: z.boolean(),
  checked: z.number(),
  results: z.array(appCheckResultSchema),
});

const appScaffoldFileSchema = z.object({
  kind: z.enum(["manifest", "spec", "skill"]),
  path: z.string(),
  action: z.enum(["planned", "created", "overwritten"]),
});

const appsScaffoldReturnSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  command: z.string(),
  dryRun: z.boolean(),
  force: z.boolean(),
  manifestPath: z.string(),
  specPath: z.string().nullable(),
  skillPath: z.string().nullable(),
  skill: z.string().nullable(),
  files: z.array(appScaffoldFileSchema),
  manifest: z.record(z.string(), jsonValueSchema),
  nextCommands: z.array(z.string()),
});

const appImportCliOperationCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  description: z.string().nullable(),
  json: z.boolean(),
  mutating: z.boolean(),
  destructive: z.boolean(),
  streaming: z.boolean(),
  interactive: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  reviewRequired: z.array(z.string()),
});

const appsImportCliReturnSchema = appsScaffoldReturnSchema.extend({
  sourceCommand: z.string(),
  source: z.enum(["manifest", "registry", "help"]),
  confidence: z.enum(["high", "medium", "low"]),
  operationCandidates: z.array(appImportCliOperationCandidateSchema),
  debugCandidates: z.array(appImportCliOperationCandidateSchema),
  warnings: z.array(z.string()),
  reviewRequired: z.array(z.string()),
});

const appGuidePromptSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  commands: z.array(z.string()),
});

const appsGuideReturnSchema = z.object({
  appId: z.string().nullable(),
  app: appDetailSchema.nullable(),
  skill: z.string(),
  skillGate: z.object({
    group: z.string(),
    skill: z.string(),
  }),
  prompts: z.array(appGuidePromptSchema),
  nextCommands: z.array(z.string()),
});

const appsRunReturnSchema = z.object({
  ok: z.boolean(),
  appId: z.string().nullable(),
  operation: z.string().nullable(),
  operationId: z.string().nullable(),
  interface: z.enum(["builtin", "cli", "sdk", "tool", "stream"]).nullable(),
  mutating: z.boolean(),
  status: z.enum(["completed", "failed"]),
  durationMs: z.number(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  command: z.string().optional(),
  handler: z.string().optional(),
  channel: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  permissionProvider: z
    .object({
      providerId: z.string(),
      providerVersion: z.string(),
      providerOperationId: z.string(),
      interface: z.enum(["builtin", "cli", "sdk", "tool"]),
      requestId: z.string(),
      decision: z.enum(["allow", "deny", "needs_grant", "not_applicable", "error", "invalid"]),
      reasonCode: z.string().nullable(),
      reason: z.string().optional(),
      durationMs: z.number(),
      cache: z.object({
        hit: z.boolean(),
        ttlSec: z.number().optional(),
      }),
      grantSuggestion: jsonValueSchema.optional(),
      audit: jsonValueSchema.optional(),
      error: z.string().optional(),
    })
    .optional(),
});

function toProviderSchemaSummary(value: unknown): z.infer<typeof appPermissionProviderSchemaSummarySchema> {
  if (typeof value === "string") {
    return { kind: "ref", ref: value, schema: null, type: null };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      kind: "inline",
      ref: null,
      schema: typeof record.schema === "string" ? record.schema : null,
      type: typeof record.type === "string" ? record.type : null,
    };
  }
  return { kind: "unknown", ref: null, schema: null, type: null };
}

function toPermissionsSummary(record: RaviAppManifestRecord): z.infer<typeof appPermissionsSchema> {
  const provider = record.permissions.provider
    ? {
        ...record.permissions.provider,
        decisionSchema: toProviderSchemaSummary(record.permissions.provider.decisionSchema),
        requestSchema: toProviderSchemaSummary(record.permissions.provider.requestSchema),
      }
    : null;
  return { ...record.permissions, provider };
}

function toSummary(record: RaviAppManifestRecord): z.infer<typeof appSummarySchema> {
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    schema: record.schema,
    source: record.source,
    path: record.path,
    relativePath: record.relativePath,
    rootPath: record.rootPath,
    interfaceNames: record.interfaceNames,
    permissions: toPermissionsSummary(record),
    valid: record.valid,
    errors: record.errors,
    warnings: record.warnings,
  };
}

function toDetail(record: RaviAppManifestRecord): z.infer<typeof appDetailSchema> {
  return {
    ...toSummary(record),
    manifest: record.manifest,
  };
}

function printAppLine(record: z.infer<typeof appSummarySchema>): void {
  const status = record.valid ? "ok" : "invalid";
  const interfaces = record.interfaceNames.length > 0 ? record.interfaceNames.join(",") : "none";
  console.log(`- ${record.id} :: ${record.source} :: ${status} :: ${interfaces} :: ${record.name ?? "(unnamed)"}`);
}

@Group({
  name: "apps",
  description: "Discover and validate Ravi app manifests",
  scope: "open",
})
export class AppsCommands {
  @Command({ name: "list", description: "List discovered Ravi apps" })
  @CommandAccess({ kind: "read", resource: "apps", action: "list", risk: "low" })
  @Returns(appsListReturnSchema)
  list(
    @Option({ flags: "--source <source>", description: "Filter by source: repo|plugin|state" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching apps to skip (default: 0)" }) offset?: string,
  ) {
    try {
      const normalizedSource = normalizeAppSource(source);
      const records = filterVisibleAppManifests(
        discoverAppManifests({ ...(normalizedSource ? { source: normalizedSource } : {}) }),
      );
      const page = paginateCliItems(records.map(toSummary), { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "apps", "list"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--source", normalizedSource ?? null],
      });
      const payload = { total: page.total, pagination, items: page.items, apps: page.items };

      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (page.items.length === 0) {
        console.log("No Ravi apps found.");
      } else {
        console.log(
          `Ravi apps (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):`,
        );
        for (const app of page.items) printAppLine(app);
        if (pagination.nextCommand) {
          console.log("\nNext page:");
          console.log(`  ${pagination.nextCommand}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "show", description: "Show a Ravi app manifest" })
  @CommandAccess({ kind: "read", resource: "apps", action: "show", risk: "low" })
  @Returns(appsShowReturnSchema)
  show(
    @Arg("id", { description: "App id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertCanUseApp(id);
      const app = toDetail(getAppManifest(id));
      const payload = { app };

      if (asJson) {
        printJson(payload);
        return payload;
      }

      console.log(`${app.id} :: ${app.name ?? "(unnamed)"}`);
      console.log(`version: ${app.version ?? "unknown"}`);
      console.log(`source: ${app.source}`);
      console.log(`path: ${app.path}`);
      console.log(`interfaces: ${app.interfaceNames.join(", ") || "none"}`);
      console.log(`status: ${app.valid ? "ok" : "invalid"}`);
      if (app.errors.length > 0) {
        console.log("errors:");
        for (const error of app.errors) console.log(`  - ${error}`);
      }
      if (app.warnings.length > 0) {
        console.log("warnings:");
        for (const warning of app.warnings) console.log(`  - ${warning}`);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "check", description: "Validate Ravi app manifests without executing app code" })
  @CommandAccess({ kind: "read", resource: "apps", action: "check", risk: "low" })
  @Returns(appsCheckReturnSchema)
  check(
    @Arg("id", { required: false, description: "Optional app id. Omit to check all discovered apps." }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      if (id?.trim()) assertCanUseApp(id);
      const results = filterVisibleAppChecks(checkAppManifests(id));
      const payload = {
        ok: results.every((result) => result.ok),
        checked: results.length,
        results,
      };

      if (asJson) {
        printJson(payload);
        if (!payload.ok && getContext()?.suppressCliOutput !== true) process.exitCode = 1;
        return payload;
      }

      if (payload.checked === 0) {
        console.log("No Ravi apps found.");
      } else if (payload.ok) {
        console.log(`All ${payload.checked} Ravi app manifest(s) are valid.`);
      } else {
        console.log(
          `${payload.results.filter((result) => !result.ok).length} of ${payload.checked} app manifest(s) failed.`,
        );
        for (const result of payload.results.filter((entry) => !entry.ok)) {
          console.log(`- ${result.id} :: ${result.path}`);
          for (const error of result.errors) console.log(`  error: ${error}`);
        }
      }

      for (const result of payload.results.filter((entry) => entry.warnings.length > 0)) {
        console.log(`warnings for ${result.id}:`);
        for (const warning of result.warnings) console.log(`  - ${warning}`);
      }
      if (!payload.ok && getContext()?.suppressCliOutput !== true) process.exitCode = 1;
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "run", description: "Run a Ravi app operation through the runtime app router" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "run", risk: "high" })
  @Returns(appsRunReturnSchema)
  async run(
    @Arg("id", { description: "App id" }) id: string,
    @Arg("operation", { required: false, description: "Operation name. Defaults to app help." }) operation?: string,
    @Arg("args", { required: false, variadic: true, description: "Operation arguments" }) rest?: string[],
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const wantsJson = asJson === true || getContext()?.suppressCliOutput === true;
    const result = await runAppOperation({
      appId: id,
      operation,
      args: rest ?? [],
      json: wantsJson,
    });

    printAppRunResult(result, { json: wantsJson });
    if (!result.ok && getContext()?.suppressCliOutput !== true) process.exitCode = 1;
    return result;
  }

  @Command({ name: "scaffold", description: "Create a Ravi app scaffold from the app contract" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "scaffold", risk: "medium" })
  @Returns(appsScaffoldReturnSchema)
  scaffold(
    @Arg("id", { description: "Stable app id, e.g. music or music/player" }) id: string,
    @Option({ flags: "--name <name>", description: "Human display name" }) name?: string,
    @Option({ flags: "--description <text>", description: "Short app description" }) description?: string,
    @Option({ flags: "--command <command>", description: "Canonical CLI command (default: ravi <id>)" })
    command?: string,
    @Option({ flags: "--dry-run", description: "Print planned files without writing" }) dryRun?: boolean,
    @Option({ flags: "--force", description: "Overwrite existing scaffold files" }) force?: boolean,
    @Option({ flags: "--skip-ui", description: "Do not include interfaces.ui in the manifest" }) skipUi?: boolean,
    @Option({ flags: "--skip-skill", description: "Do not create a skill skeleton" }) skipSkill?: boolean,
    @Option({ flags: "--skip-spec", description: "Do not create an app spec skeleton" }) skipSpec?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const payload = scaffoldApp({
        id,
        name,
        description,
        command,
        dryRun,
        force,
        includeUi: skipUi !== true,
        includeSkill: skipSkill !== true,
        includeSpec: skipSpec !== true,
      });

      if (asJson) {
        printJson(payload);
        return payload;
      }

      console.log(`${payload.dryRun ? "Planned" : "Created"} Ravi app scaffold: ${payload.id}`);
      for (const file of payload.files) {
        console.log(`- ${file.action} ${file.kind}: ${file.path}`);
      }
      console.log("\nNext commands:");
      for (const nextCommand of payload.nextCommands) console.log(`  ${nextCommand}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "import-cli", description: "Create a Ravi app draft from an existing CLI contract" })
  @CommandAccess({ kind: "mutate", resource: "apps", action: "import-cli", risk: "high" })
  @Returns(appsImportCliReturnSchema)
  importCli(
    @Arg("command", { description: "CLI command to import, e.g. 'ravi apps' or 'my-cli'" }) command: string,
    @Option({ flags: "--id <id>", description: "Stable app id to generate" }) id?: string,
    @Option({ flags: "--name <name>", description: "Human display name" }) name?: string,
    @Option({ flags: "--description <text>", description: "Short app description" }) description?: string,
    @Option({ flags: "--source <source>", description: "Import source: auto|manifest|registry|help" }) source?: string,
    @Option({ flags: "--dry-run", description: "Print planned files without writing" }) dryRun?: boolean,
    @Option({ flags: "--force", description: "Overwrite existing scaffold files" }) force?: boolean,
    @Option({ flags: "--skip-ui", description: "Do not include interfaces.ui in the manifest" }) skipUi?: boolean,
    @Option({ flags: "--skip-skill", description: "Do not create a skill skeleton" }) skipSkill?: boolean,
    @Option({ flags: "--skip-spec", description: "Do not create an app spec skeleton" }) skipSpec?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const appId = id?.trim();
      if (!appId) throw new Error("Missing --id <app-id> for CLI import.");
      const normalizedSource = normalizeImportSource(source);
      const payload = importCliApp({
        id: appId,
        command,
        name,
        description,
        ...(normalizedSource ? { source: normalizedSource } : {}),
        dryRun,
        force,
        includeUi: skipUi !== true,
        includeSkill: skipSkill !== true,
        includeSpec: skipSpec !== true,
      });

      if (asJson) {
        printJson(payload);
        return payload;
      }

      console.log(`${payload.dryRun ? "Planned" : "Created"} Ravi app import: ${payload.id}`);
      console.log(`source: ${payload.source} (${payload.confidence})`);
      console.log(`command: ${payload.sourceCommand}`);
      console.log(`operations: ${payload.operationCandidates.length}`);
      if (payload.debugCandidates.length > 0) console.log(`debug candidates: ${payload.debugCandidates.length}`);
      for (const warning of payload.warnings) console.log(`warning: ${warning}`);
      for (const item of payload.reviewRequired) console.log(`review: ${item}`);
      for (const file of payload.files) console.log(`- ${file.action} ${file.kind}: ${file.path}`);
      console.log("\nNext commands:");
      for (const nextCommand of payload.nextCommands) console.log(`  ${nextCommand}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "guide", description: "Print agent guidance for discovering, scaffolding, and operating Ravi apps" })
  @CommandAccess({ kind: "read", resource: "apps", action: "guide", risk: "low" })
  @Returns(appsGuideReturnSchema)
  guide(
    @Arg("id", { required: false, description: "Optional app id for app-specific prompts" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.printGuide(id, asJson);
  }

  @Command({ name: "prompts", description: "Print all built-in Ravi apps agent prompts" })
  @CommandAccess({ kind: "read", resource: "apps", action: "prompts", risk: "low" })
  @Returns(appsGuideReturnSchema)
  prompts(
    @Arg("id", { required: false, description: "Optional app id for app-specific prompts" }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.printGuide(id, asJson);
  }

  private printGuide(id?: string, asJson?: boolean): z.infer<typeof appsGuideReturnSchema> | undefined {
    try {
      const guide = buildAppsGuide(id);
      const payload = {
        ...guide,
        app: guide.app ? toDetail(guide.app) : null,
      };

      if (asJson) {
        printJson(payload);
        return payload;
      }

      console.log("Ravi Apps guide");
      console.log(`skill: ${payload.skill}`);
      console.log(`skill gate: ${payload.skillGate.group} -> ${payload.skillGate.skill}`);
      if (payload.app) {
        console.log(`app: ${payload.app.id} (${payload.app.interfaceNames.join(", ") || "no interfaces"})`);
      }
      for (const prompt of payload.prompts) {
        console.log(`\n${prompt.id}: ${prompt.title}`);
        console.log(prompt.prompt);
        for (const command of prompt.commands) console.log(`  ${command}`);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

function normalizeImportSource(value?: string): "auto" | "manifest" | "registry" | "help" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "auto" || normalized === "manifest" || normalized === "registry" || normalized === "help") {
    return normalized;
  }
  throw new Error(`Invalid import source: ${value}. Use auto|manifest|registry|help.`);
}

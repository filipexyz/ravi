import "reflect-metadata";
import { z } from "zod";
import { Arg, Command, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  checkAppManifests,
  discoverAppManifests,
  getAppManifest,
  normalizeAppSource,
  type RaviAppManifestRecord,
} from "../../apps/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const appPermissionsSchema = z.object({
  required: z.array(z.string()),
  optional: z.array(z.string()),
  mutating: z.array(z.string()),
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
    permissions: record.permissions,
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
  @Returns(appsListReturnSchema)
  list(
    @Option({ flags: "--source <source>", description: "Filter by source: repo|plugin|state" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching apps to skip (default: 0)" }) offset?: string,
  ) {
    try {
      const normalizedSource = normalizeAppSource(source);
      const records = discoverAppManifests({ ...(normalizedSource ? { source: normalizedSource } : {}) });
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
  @Returns(appsShowReturnSchema)
  show(
    @Arg("id", { description: "App id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
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
  @Returns(appsCheckReturnSchema)
  check(
    @Arg("id", { required: false, description: "Optional app id. Omit to check all discovered apps." }) id?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const results = checkAppManifests(id);
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
}

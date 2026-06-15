import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  createSpec,
  getSpecContext,
  listSpecs,
  normalizeSpecContextMode,
  normalizeSpecKind,
  syncSpecs,
  type SpecContextMode,
  type SpecKind,
  type SpecRecord,
} from "../../specs/index.js";
import {
  specContextReturnSchema,
  specCreateReturnSchema,
  specsListReturnSchema,
  specsSyncReturnSchema,
} from "./operational-return-schemas.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printSpecSummary(spec: SpecRecord): void {
  console.log(`- ${spec.id} :: ${spec.kind} :: ${spec.status} :: ${spec.title}`);
}

@Group({
  name: "specs",
  description: "Versioned Ravi specs memory",
  scope: "open",
})
export class SpecsCommands {
  @Command({ name: "list", description: "List specs from .ravi/specs" })
  @CommandAccess({ kind: "read", resource: "specs", action: "list", risk: "low" })
  @Returns(specsListReturnSchema)
  list(
    @Option({ flags: "--domain <domain>", description: "Filter by domain" }) domain?: string,
    @Option({ flags: "--kind <kind>", description: "Filter by kind: domain|capability|feature" }) kind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching specs to skip (default: 0)" }) offset?: string,
  ) {
    try {
      const specs = listSpecs({
        ...(domain?.trim() ? { domain: domain.trim() } : {}),
        ...(kind?.trim() ? { kind: normalizeSpecKind(kind) } : {}),
      });
      const page = paginateCliItems(specs, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "specs", "list"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--domain", domain?.trim() || null, "--kind", kind?.trim() || null],
      });
      const payload = { total: page.total, pagination, items: page.items, specs: page.items };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (page.items.length === 0) {
        console.log("No specs found.");
      } else {
        console.log(
          `Specs (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):`,
        );
        for (const spec of page.items) printSpecSummary(spec);
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

  @Command({ name: "get", description: "Get inherited spec context" })
  @CommandAccess({ kind: "read", resource: "specs", action: "get", risk: "low" })
  @Returns(specContextReturnSchema)
  get(
    @Arg("id", { description: "Spec id: domain[/capability[/feature]]" }) id: string,
    @Option({ flags: "--mode <mode>", description: "rules|full|checks|why|runbook", defaultValue: "rules" })
    mode?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const normalizedMode: SpecContextMode = normalizeSpecContextMode(mode);
      const context = getSpecContext(id, { mode: normalizedMode });
      const payload = { context };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (!context.content.trim()) {
        console.log(`No ${normalizedMode} context found for ${context.id}.`);
      } else {
        console.log(context.content);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "new", description: "Create a new spec under .ravi/specs" })
  @CommandAccess({ kind: "read", resource: "specs", action: "new", risk: "low" })
  @Returns(specCreateReturnSchema)
  new(
    @Arg("id", { description: "Spec id: domain[/capability[/feature]]" }) id: string,
    @Option({ flags: "--title <title>", description: "Spec title" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature" }) kind?: string,
    @Option({ flags: "--full", description: "Create WHY.md, RUNBOOK.md, and CHECKS.md companions" }) full?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      if (!title?.trim()) fail("--title is required.");
      if (!kind?.trim()) fail("--kind is required.");
      const normalizedKind: SpecKind = normalizeSpecKind(kind);
      const result = createSpec({
        id,
        title: title.trim(),
        kind: normalizedKind,
        full: full === true,
      });
      const payload = {
        status: "created",
        spec: result.spec,
        createdFiles: result.createdFiles,
        missingAncestors: result.missingAncestors,
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      console.log(`Created spec: ${result.spec.id}`);
      for (const file of result.createdFiles) {
        console.log(`  ${file}`);
      }
      if (result.missingAncestors.length > 0) {
        console.log("Missing ancestor specs:");
        for (const ancestor of result.missingAncestors) {
          console.log(`  - ${ancestor.id}`);
        }
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "sync", description: "Rebuild the specs SQLite index from Markdown" })
  @CommandAccess({ kind: "mutate", resource: "specs", action: "sync", risk: "high" })
  @Returns(specsSyncReturnSchema)
  sync(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    try {
      const result = syncSpecs();
      const payload = { status: "synced", ...result };
      if (asJson) {
        printJson(payload);
        return payload;
      }
      console.log(`Synced ${result.total} specs from ${result.rootPath}`);
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
}

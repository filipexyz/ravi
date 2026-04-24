import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
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
  list(
    @Option({ flags: "--domain <domain>", description: "Filter by domain" }) domain?: string,
    @Option({ flags: "--kind <kind>", description: "Filter by kind: domain|capability|feature" }) kind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      const specs = listSpecs({
        ...(domain?.trim() ? { domain: domain.trim() } : {}),
        ...(kind?.trim() ? { kind: normalizeSpecKind(kind) } : {}),
      });
      const payload = { total: specs.length, specs };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (specs.length === 0) {
        console.log("No specs found.");
      } else {
        console.log(`Specs (${specs.length}):`);
        for (const spec of specs) printSpecSummary(spec);
      }
      return payload;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  @Command({ name: "get", description: "Get inherited spec context" })
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

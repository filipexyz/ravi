import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { CONTRACT_EXIT_USAGE, ContractError, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  applySpecsFacadePlan,
  buildSpecsFacadePlan,
  createSpec,
  getSpecContext,
  listSpecs,
  normalizeSpecContextMode,
  normalizeSpecKind,
  readbackSpecsFacade,
  recoverSpecsFacade,
  SPECS_FACADE_OPERATIONS,
  SpecsFacadeError,
  syncSpecs,
  verifySpecsFacade,
  type SpecContextMode,
  type SpecsFacadeIntent,
  type SpecKind,
  type SpecRecord,
} from "../../specs/index.js";
import {
  specContextReturnSchema,
  specCreateReturnSchema,
  specsFacadeApplyReturnSchema,
  specsFacadePlanReturnSchema,
  specsFacadeReadbackReturnSchema,
  specsFacadeRecoveryReturnSchema,
  specsFacadeVerificationReturnSchema,
  specsListReturnSchema,
  specsSyncReturnSchema,
} from "./operational-return-schemas.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printSpecSummary(spec: SpecRecord): void {
  console.log(`- ${spec.id} :: ${spec.kind} :: ${spec.status} :: ${spec.title}`);
}

// ============================================================
// Manual v2 contract helpers (error envelope + suggestions).
// Exit taxonomy: 1 not-found · 2 usage. `sync` and `new` are
// local, non-destructive writes: declared UNBRAKED (no --execute).
// ============================================================

const SPEC_CONTEXT_MODES = ["rules", "full", "checks", "why", "runbook"] as const;
const SPEC_KINDS = ["domain", "capability", "feature"] as const;

/** Real spec ids for NOT_FOUND suggestions; empty when the index is unreadable. */
function specIdCandidates(): string[] {
  try {
    return listSpecs().map((spec) => spec.id);
  } catch {
    return [];
  }
}

function failSpecNotFound(op: string, id: string, asJson?: boolean): never {
  contractFail(op, "SPEC_NOT_FOUND", `Spec not found: ${id}`, {
    asJson,
    details: {
      suggestedAction: "Check the spec id (see suggestions) or run `ravi specs list`",
      suggestions: suggestSimilar(id, specIdCandidates()),
    },
  });
}

function failSpecsUsage(op: string, message: string, acceptedValues: readonly string[], asJson?: boolean): never {
  contractFail(op, "USAGE_ERROR", message, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: {
      suggestedAction: `Re-run '${op}' with one of: ${acceptedValues.join(", ")}`,
      acceptedValues: [...acceptedValues],
    },
  });
}

function facadeIntent(
  op: string,
  operation: string,
  id?: string,
  title?: string,
  kind?: string,
  full?: boolean,
  asJson?: boolean,
): SpecsFacadeIntent {
  if (!SPECS_FACADE_OPERATIONS.includes(operation as (typeof SPECS_FACADE_OPERATIONS)[number])) {
    failSpecsUsage(op, `Invalid specs facade operation: ${operation}. Use new|sync.`, SPECS_FACADE_OPERATIONS, asJson);
  }
  if (operation === "sync") {
    if (id?.trim() || title?.trim() || kind?.trim() || full === true) {
      contractFail(op, "USAGE_ERROR", "The sync operation does not accept spec creation arguments.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
        details: { suggestedAction: `Run '${op} sync' without id, --title, --kind, or --full` },
      });
    }
    return { operation: "sync" };
  }
  if (!id?.trim()) failSpecsUsage(op, "A spec id is required for facade new.", ["<id>"], asJson);
  if (!title?.trim()) failSpecsUsage(op, "--title is required for facade new.", ["--title <title>"], asJson);
  if (!kind?.trim()) failSpecsUsage(op, "--kind is required for facade new.", SPEC_KINDS, asJson);
  let normalizedKind: SpecKind;
  try {
    normalizedKind = normalizeSpecKind(kind);
  } catch {
    failSpecsUsage(op, `Invalid --kind: ${kind}. Use domain|capability|feature.`, SPEC_KINDS, asJson);
  }
  return {
    operation: "new",
    id: id.trim(),
    title: title.trim(),
    kind: normalizedKind,
    full: full === true,
  };
}

function failFacade(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof ContractError) throw error;
  if (error instanceof SpecsFacadeError) {
    contractFail(op, error.code, error.message, { asJson, details: error.details });
  }
  fail(error instanceof Error ? error.message : String(error));
}

@Group({
  name: "specs",
  description: "Versioned Ravi specs memory",
  scope: "open",
})
export class SpecsCommands {
  @Command({ name: "list", description: "List specs from .ravi/specs" })
  @CommandAccess({ kind: "read", resource: "specs", action: "list", risk: "low", effectClass: "none" })
  @Returns(specsListReturnSchema)
  list(
    @Option({ flags: "--domain <domain>", description: "Filter by domain" }) domain?: string,
    @Option({ flags: "--kind <kind>", description: "Filter by kind: domain|capability|feature" }) kind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching specs to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    let normalizedKind: SpecKind | undefined;
    if (kind?.trim()) {
      try {
        normalizedKind = normalizeSpecKind(kind);
      } catch {
        failSpecsUsage("specs list", `Invalid --kind: ${kind}. Use domain|capability|feature.`, SPEC_KINDS, asJson);
      }
    }
    try {
      const specs = listSpecs({
        ...(domain?.trim() ? { domain: domain.trim() } : {}),
        ...(normalizedKind ? { kind: normalizedKind } : {}),
      });
      const page = paginateCliItems(specs, { limit, offset });
      const pagination = buildCliOffsetPagination({
        fields,
        baseCommand: ["ravi", "specs", "list"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--domain", domain?.trim() || null, "--kind", kind?.trim() || null],
      });
      const projectedItems = pickFields(page.items, fields);
      const payload = { total: page.total, pagination, items: projectedItems, specs: projectedItems };
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
  @CommandAccess({ kind: "read", resource: "specs", action: "get", risk: "low", effectClass: "none" })
  @Returns(specContextReturnSchema)
  get(
    @Arg("id", { description: "Spec id: domain[/capability[/feature]]" }) id: string,
    @Option({ flags: "--mode <mode>", description: "rules|full|checks|why|runbook", defaultValue: "rules" })
    mode?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    let normalizedMode: SpecContextMode;
    try {
      normalizedMode = normalizeSpecContextMode(mode);
    } catch {
      failSpecsUsage(
        "specs get",
        `Invalid --mode: ${mode}. Use rules|full|checks|why|runbook.`,
        SPEC_CONTEXT_MODES,
        asJson,
      );
    }
    try {
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
      const message = error instanceof Error ? error.message : String(error);
      // getSpecContext throws on unknown ids; map that to the contract envelope.
      if (/^Spec not found/i.test(message)) {
        failSpecNotFound("specs get", id, asJson);
      }
      fail(message);
    }
  }

  @Command({ name: "new", description: "Create a new spec under .ravi/specs" })
  @CommandAccess({
    kind: "mutate",
    resource: "specs",
    action: "new",
    risk: "medium",
    effectClass: "local-reversible",
  })
  @Returns(specCreateReturnSchema)
  new(
    @Arg("id", { description: "Spec id: domain[/capability[/feature]]" }) id: string,
    @Option({ flags: "--title <title>", description: "Spec title" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature" }) kind?: string,
    @Option({ flags: "--full", description: "Create WHY.md, RUNBOOK.md, and CHECKS.md companions" }) full?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // `new` only creates local Markdown files and fails on existing specs, so it
    // stays UNBRAKED (no --execute) under the Manual v2 write classification.
    if (!title?.trim()) {
      failSpecsUsage("specs new", "--title is required.", ["--title <title>"], asJson);
    }
    if (!kind?.trim()) {
      failSpecsUsage("specs new", "--kind is required.", SPEC_KINDS, asJson);
    }
    let normalizedKind: SpecKind;
    try {
      normalizedKind = normalizeSpecKind(kind);
    } catch {
      failSpecsUsage("specs new", `Invalid --kind: ${kind}. Use domain|capability|feature.`, SPEC_KINDS, asJson);
    }
    try {
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

  // Manual v2 write classification: `sync` is an idempotent local reindex
  // (Markdown stays the source of truth; the SQLite index is rebuildable), so
  // it stays UNBRAKED (no --execute). CI quality gates call syncSpecs() too.
  @Command({ name: "sync", description: "Rebuild the specs SQLite index from Markdown" })
  @CommandAccess({
    kind: "mutate",
    resource: "specs",
    action: "sync",
    risk: "medium",
    effectClass: "local-reversible",
  })
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

@Group({
  name: "specs.facade",
  description: "Plan, apply, verify, and recover safe local specs effects",
  scope: "open",
})
export class SpecsFacadeCommands {
  @Command({ name: "plan", description: "Build a bound specs plan without writing state" })
  @CommandAccess({ kind: "read", resource: "specs.facade", action: "plan", risk: "low", effectClass: "none" })
  @Returns(specsFacadePlanReturnSchema)
  plan(
    @Arg("operation", { description: "new|sync" }) operation: string,
    @Arg("id", { required: false, description: "Spec id for new" }) id?: string,
    @Option({ flags: "--title <title>", description: "Spec title for new" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature for new" }) kind?: string,
    @Option({ flags: "--full", description: "Include WHY.md, RUNBOOK.md, and CHECKS.md" }) full?: boolean,
    @Option({ flags: "--json", description: "Print the bound plan as JSON" }) asJson?: boolean,
  ) {
    const op = "specs facade plan";
    try {
      const payload = buildSpecsFacadePlan(facadeIntent(op, operation, id, title, kind, full, asJson));
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      failFacade(op, error, asJson);
    }
  }

  @Command({ name: "apply", description: "Apply one bound specs plan and confirm it by readback" })
  @CommandAccess({
    kind: "mutate",
    resource: "specs.facade",
    action: "apply",
    risk: "medium",
    effectClass: "local-reversible",
  })
  @Returns(specsFacadeApplyReturnSchema)
  apply(
    @Arg("operation", { description: "new|sync" }) operation: string,
    @Arg("planHash", { description: "Exact hash returned by facade plan" }) planHash: string,
    @Arg("id", { required: false, description: "Spec id for new" }) id?: string,
    @Option({ flags: "--title <title>", description: "Spec title for new" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature for new" }) kind?: string,
    @Option({ flags: "--full", description: "Include WHY.md, RUNBOOK.md, and CHECKS.md" }) full?: boolean,
    @Option({ flags: "--json", description: "Print application and readback as JSON" }) asJson?: boolean,
  ) {
    const op = "specs facade apply";
    try {
      const payload = applySpecsFacadePlan(facadeIntent(op, operation, id, title, kind, full, asJson), planHash);
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      failFacade(op, error, asJson);
    }
  }

  @Command({ name: "readback", description: "Read files, ancestors, and index for a bound specs plan" })
  @CommandAccess({
    kind: "read",
    resource: "specs.facade",
    action: "readback",
    risk: "low",
    effectClass: "none",
  })
  @Returns(specsFacadeReadbackReturnSchema)
  readback(
    @Arg("operation", { description: "new|sync" }) operation: string,
    @Arg("planHash", { description: "Exact hash returned by facade plan" }) planHash: string,
    @Arg("id", { required: false, description: "Spec id for new" }) id?: string,
    @Option({ flags: "--title <title>", description: "Spec title for new" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature for new" }) kind?: string,
    @Option({ flags: "--full", description: "Include WHY.md, RUNBOOK.md, and CHECKS.md" }) full?: boolean,
    @Option({ flags: "--json" }) asJson?: boolean,
  ) {
    const op = "specs facade readback";
    try {
      const payload = readbackSpecsFacade(facadeIntent(op, operation, id, title, kind, full, asJson), planHash);
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      failFacade(op, error, asJson);
    }
  }

  @Command({ name: "verify", description: "Classify current state against a bound specs plan" })
  @CommandAccess({ kind: "read", resource: "specs.facade", action: "verify", risk: "low", effectClass: "none" })
  @Returns(specsFacadeVerificationReturnSchema)
  verify(
    @Arg("operation", { description: "new|sync" }) operation: string,
    @Arg("planHash", { description: "Exact hash returned by facade plan" }) planHash: string,
    @Arg("id", { required: false, description: "Spec id for new" }) id?: string,
    @Option({ flags: "--title <title>", description: "Spec title for new" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature for new" }) kind?: string,
    @Option({ flags: "--full", description: "Include WHY.md, RUNBOOK.md, and CHECKS.md" }) full?: boolean,
    @Option({ flags: "--json" }) asJson?: boolean,
  ) {
    const op = "specs facade verify";
    try {
      const payload = verifySpecsFacade(facadeIntent(op, operation, id, title, kind, full, asJson), planHash);
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      failFacade(op, error, asJson);
    }
  }

  @Command({ name: "recover", description: "Inspect recovery without replaying a specs effect" })
  @CommandAccess({ kind: "read", resource: "specs.facade", action: "recover", risk: "low", effectClass: "none" })
  @Returns(specsFacadeRecoveryReturnSchema)
  recover(
    @Arg("operation", { description: "new|sync" }) operation: string,
    @Arg("planHash", { description: "Exact hash returned by facade plan" }) planHash: string,
    @Arg("id", { required: false, description: "Spec id for new" }) id?: string,
    @Option({ flags: "--title <title>", description: "Spec title for new" }) title?: string,
    @Option({ flags: "--kind <kind>", description: "domain|capability|feature for new" }) kind?: string,
    @Option({ flags: "--full", description: "Include WHY.md, RUNBOOK.md, and CHECKS.md" }) full?: boolean,
    @Option({ flags: "--json" }) asJson?: boolean,
  ) {
    const op = "specs facade recover";
    try {
      const payload = recoverSpecsFacade(facadeIntent(op, operation, id, title, kind, full, asJson), planHash);
      if (asJson) printJson(payload);
      else console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      failFacade(op, error, asJson);
    }
  }
}

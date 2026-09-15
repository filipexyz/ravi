import "reflect-metadata";
import { resolve } from "node:path";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { CONTRACT_EXIT_USAGE, contractFail, pickFields, suggestSimilar } from "../agent-contract.js";
import { looseObjectSchema } from "../return-schemas.js";
import {
  importRaviRules,
  listRaviRulesImportSources,
  type RaviRulesImportCandidate,
  type RaviRulesImportProviderFilter,
  type RaviRulesImportResult,
  type RaviRulesImportSource,
} from "../../runtime/ravi-rules.js";

type SerializedImportCandidate = Omit<RaviRulesImportCandidate, "content">;

const rulesSourcesReturnSchema = z.object({
  cwd: z.string(),
  provider: z.enum(["all", "claude", "agents"]),
  includeUser: z.boolean(),
  sources: z.array(looseObjectSchema),
  counts: z.object({
    sources: z.number(),
    existingSources: z.number(),
    missingSources: z.number(),
  }),
});

const rulesImportReturnSchema = z
  .object({
    cwd: z.string(),
    includeUser: z.boolean(),
    write: z.boolean(),
    force: z.boolean(),
    rulesDir: z.string(),
    sources: z.array(looseObjectSchema),
    candidates: z.array(looseObjectSchema),
    counts: looseObjectSchema,
  })
  .passthrough();

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const PROVIDER_FILTERS = ["all", "claude", "agents"] as const;

/**
 * Manual v2 contract: an invalid provider value is a usage error (exit 2), with
 * the accepted values and the closest real candidates in the envelope.
 */
function parseProviderFilter(op: string, source?: string, asJson?: boolean): RaviRulesImportProviderFilter {
  const normalized = (source ?? "all").trim().toLowerCase();
  if (normalized === "all" || normalized === "claude" || normalized === "agents") {
    return normalized;
  }
  contractFail(op, "USAGE_ERROR", `Invalid source provider: ${source}. Use all, claude, or agents.`, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: {
      suggestedAction: `Re-run '${op}' with source one of: ${PROVIDER_FILTERS.join(", ")}`,
      acceptedValues: [...PROVIDER_FILTERS],
      suggestions: suggestSimilar(normalized, [...PROVIDER_FILTERS]),
    },
  });
}

function resolveWorkspaceCwd(cwd?: string): string {
  return resolve(cwd?.trim() || process.cwd());
}

function serializeCandidate(candidate: RaviRulesImportCandidate): SerializedImportCandidate {
  const { content: _content, ...rest } = candidate;
  return rest;
}

function serializeImportResult(result: RaviRulesImportResult): Omit<RaviRulesImportResult, "candidates"> & {
  candidates: SerializedImportCandidate[];
} {
  return {
    ...result,
    candidates: result.candidates.map(serializeCandidate),
  };
}

function formatSourceStatus(source: RaviRulesImportSource): string {
  return `${source.provider.padEnd(6)} ${source.scope.padEnd(7)} ${source.exists ? "found  " : "missing"} ${source.path}`;
}

@Group({
  name: "rules",
  description: "Manage Ravi runtime prompt rules",
  scope: "admin",
})
export class RulesCommands {
  @Command({ name: "sources", description: "List importable provider rule sources" })
  @CommandAccess({ kind: "read", resource: "rules", action: "sources", risk: "low" })
  @Returns(rulesSourcesReturnSchema)
  async sources(
    @Arg("source", { required: false, description: "Source provider: all, claude, agents", defaultValue: "all" })
    source?: string,
    @Option({ flags: "--cwd <path>", description: "Workspace cwd to inspect (default: current directory)" })
    cwd?: string,
    @Option({ flags: "--include-user", description: "Also include user-level ~/.claude/rules and ~/.agents/rules" })
    includeUser?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each source" })
    fields?: string,
  ): Promise<unknown> {
    const workspaceCwd = resolveWorkspaceCwd(cwd);
    const provider = parseProviderFilter("rules sources", source, asJson);
    const sources = await listRaviRulesImportSources({
      cwd: workspaceCwd,
      provider,
      includeUser: includeUser === true,
    });
    const payload = {
      cwd: workspaceCwd,
      provider,
      includeUser: includeUser === true,
      sources: pickFields(sources, fields),
      counts: {
        sources: sources.length,
        existingSources: sources.filter((candidate) => candidate.exists).length,
        missingSources: sources.filter((candidate) => !candidate.exists).length,
      },
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(`Ravi rule import sources for ${workspaceCwd}:`);
    for (const item of sources) {
      console.log(`  ${formatSourceStatus(item)}`);
    }
    if (!includeUser) {
      console.log("  (user-level sources are hidden; pass --include-user to inspect them)");
    }
    return payload;
  }

  // Manual v2 write brake note: `import` keeps its NATIVE, pre-existing brake
  // instead of gaining `--execute` — without `--write` it is a dry-run (no
  // files), and with `--write` existing imported files are still skipped unless
  // `--force` is passed. `--write` (+ `--force` for overwrite) is the declared
  // contract equivalent of `--execute` for this domain.
  @Command({ name: "import", description: "Import provider rules into .ravi/rules/imported (dry-run without --write)" })
  @CommandAccess({ kind: "mutate", resource: "rules", action: "import", risk: "high" })
  @Returns(rulesImportReturnSchema)
  async importRules(
    @Arg("source", { required: false, description: "Source provider: all, claude, agents", defaultValue: "all" })
    source?: string,
    @Option({ flags: "--cwd <path>", description: "Workspace cwd to import into (default: current directory)" })
    cwd?: string,
    @Option({ flags: "--include-user", description: "Also import user-level ~/.claude/rules and ~/.agents/rules" })
    includeUser?: boolean,
    @Option({ flags: "--write", description: "Write files. Without this, import runs as dry-run" })
    write?: boolean,
    @Option({ flags: "--force", description: "Overwrite existing imported rule files" })
    force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ): Promise<unknown> {
    const workspaceCwd = resolveWorkspaceCwd(cwd);
    const provider = parseProviderFilter("rules import", source, asJson);
    const result = await importRaviRules({
      cwd: workspaceCwd,
      provider,
      includeUser: includeUser === true,
      write: write === true,
      force: force === true,
    });
    const payload = serializeImportResult(result);

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(`${result.write ? "Imported" : "Dry-run"} ${result.counts.candidates} rule(s) into ${result.rulesDir}`);
    if (!result.write) {
      console.log("Pass --write to create files.");
    }
    for (const candidate of result.candidates) {
      const verb =
        candidate.action === "skip_exists" ? "skip" : result.write ? candidate.action : `would-${candidate.action}`;
      console.log(`  ${verb.padEnd(15)} ${candidate.destinationRelativePath} <- ${candidate.sourcePath}`);
    }
    for (const sourceItem of result.sources.filter((item) => !item.exists)) {
      console.log(`  missing-source ${sourceItem.provider}/${sourceItem.scope}: ${sourceItem.path}`);
    }
    return payload;
  }
}

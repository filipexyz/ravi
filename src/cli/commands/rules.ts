import "reflect-metadata";
import { resolve } from "node:path";
import { z } from "zod";
import { Arg, Command, Group, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
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

function parseProviderFilter(source?: string): RaviRulesImportProviderFilter {
  const normalized = (source ?? "all").trim().toLowerCase();
  if (normalized === "all" || normalized === "claude" || normalized === "agents") {
    return normalized;
  }
  fail("Source must be one of: all, claude, agents");
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
  ): Promise<unknown> {
    const workspaceCwd = resolveWorkspaceCwd(cwd);
    const provider = parseProviderFilter(source);
    const sources = await listRaviRulesImportSources({
      cwd: workspaceCwd,
      provider,
      includeUser: includeUser === true,
    });
    const payload = {
      cwd: workspaceCwd,
      provider,
      includeUser: includeUser === true,
      sources,
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

  @Command({ name: "import", description: "Import provider rules into .ravi/rules/imported" })
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
    const provider = parseProviderFilter(source);
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

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { ContractError, contractDryRun, pickFields } from "../agent-contract.js";
import { CloudAuthError, cloudAuthErrorFromUnknown } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  getBugReportStatus,
  listBugReports,
  submitBugReport,
  type BugReportClientDeps,
  type BugReportListResult,
  type BugReportStatusResult,
  type BugReportSubmitResult,
} from "../../bug-report/client.js";
import { BUG_REPORT_COLLECTION_PROMPT } from "../../bug-report/prompt.js";
import {
  BUG_REPORT_SCHEMA_ID,
  type BugReportDossier,
  normalizeBugReportSeverity,
  parseBugReportDossierJson,
  requireCompleteBugReportDossier,
  summarizeBugReportPlan,
  validateBugReportDossier,
} from "../../bug-report/schema.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import { jsonObjectSchema, strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

export interface BugCommandDeps extends BugReportClientDeps {
  client?: ConsoleApiClient;
}

const BUG_REPORT_HELP = `
USE
  File a global Ravi product/runtime bug to Console. First call is collect-only.
  Organization/project are optional dossier fields, not CLI scope.

NÃO USE
  ✗ ravi feedback send --kind bug — feedback is a different inbox
  ✗ --execute before the dossier is sanitized and the user confirmed
  ✗ putting tokens, cookies, or private keys in evidence

REGRAS HARD
  • Dry-run by default (exit 3). Brake fires BEFORE ravi login / any POST.
  • Schema: ${BUG_REPORT_SCHEMA_ID}
  • Required on submit: title, summary, severity (low|medium|high|critical)
  • Sanitize first. Record redactions in evidence.redactions / sanitization.rulesApplied.

HITL OBRIGATÓRIO
  Ask the user if they want to file. Only --execute after they say yes.

EXAMPLES
  ravi bug report --json
  ravi bug report --dossier-json '{"schemaVersion":"${BUG_REPORT_SCHEMA_ID}","title":"CLI crash","summary":"...","severity":"high"}' --execute --json
  ravi bug status bug_123 --json
  ravi bug list --json --limit 20

ON ERROR
  WRITE_REQUIRES_EXECUTE (exit 3) → fill the printed schema, confirm, add --execute
  PAYLOAD_INVALID (exit 2) → fix severity / dossier JSON / missing title+summary
  AUTH_REQUIRED (exit 1) → ravi login   (dry-run never needs this)

PIPELINE
  hit a bug → ask user → ravi bug report (collect) → sanitize → --execute → status/list

SEE ALSO
  ravi feedback send — lightweight inbox, not this dossier
  ravi specs get cli/bug-report --mode rules --json

FORMAT
  Dossier JSON object. Console path is POST /api/cli/bugs (global, not org-scoped).

FONTES
  .ravi/specs/cli/bug-report/SPEC.md
  src/cli/commands/bug.ts
  src/bug-report/client.ts
`;

const BUG_STATUS_HELP = `
USE          Look up one of your Console bug reports by id.
NÃO USE      ✗ guessing another user's id — this surface is "my reports"
EXAMPLES     ravi bug status bug_123 --json
ON ERROR     AUTH_REQUIRED → ravi login    not found → Console 404 / SERVER_UNAVAILABLE
SEE ALSO     ravi bug list --json
FONTES       .ravi/specs/cli/bug-report/SPEC.md
`;

const BUG_LIST_HELP = `
USE          List your own Console bug reports (global, not org-scoped).
NÃO USE      ✗ treating this as an org-wide inbox
EXAMPLES     ravi bug list --json --limit 20
             ravi bug list --json --fields id,title,severity --offset 20
ON ERROR     AUTH_REQUIRED → ravi login
SEE ALSO     ravi bug status <id> --json
FONTES       .ravi/specs/cli/bug-report/SPEC.md
`;

@Group({
  name: "bug",
  aliases: ["bugs"],
  description: "File and track global Ravi bug reports on Console",
  scope: "open",
})
export class BugCommands {
  constructor(private readonly deps: BugCommandDeps = {}) {}

  @Command({
    name: "report",
    aliases: ["create"],
    description: "Collect a sanitized bug dossier and submit it to Console (dry-run by default; requires --execute)",
    helpAfter: BUG_REPORT_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "bug", action: "report", risk: "low", requiresConfirmation: true })
  async report(
    @Option({ flags: "--title <text>", description: "Short bug title" }) title?: string,
    @Option({ flags: "--summary <text>", description: "What broke and why it matters" }) summary?: string,
    @Option({ flags: "--severity <severity>", description: "low|medium|high|critical" }) severity?: string,
    @Option({ flags: "--surface <name>", description: "Product surface, e.g. cli/runtime" }) surface?: string,
    @Option({ flags: "--dossier-json <json>", description: `Full ${BUG_REPORT_SCHEMA_ID} JSON object` })
    dossierJson?: string,
    @Option({ flags: "--dossier-file <path>", description: "Path to a dossier JSON file" }) dossierFile?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description:
        "Actually submit the bug dossier to Ravi Console; default is a dry-run that prints the collection prompt (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBugCommand(asJson, async () => {
      const dossier = assembleDossier({
        title,
        summary,
        severity,
        surface,
        dossierJson,
        dossierFile,
        requireComplete: execute === true,
      });
      if (execute !== true) {
        if (!asJson) {
          console.log(BUG_REPORT_COLLECTION_PROMPT);
          console.log("");
        }
        // Write brake (Manual v2): POST /api/cli/bugs leaves the machine.
        // Collect + sanitize first; auth and network stay behind --execute.
        contractDryRun(
          "bug report",
          {
            ...summarizeBugReportPlan(dossier),
            collectionPrompt: BUG_REPORT_COLLECTION_PROMPT,
          },
          { asJson },
        );
      }
      const result = await submitBugReport(
        { console: consoleUrl, dossier: requireCompleteBugReportDossier(dossier), source: "cli" },
        this.deps,
      );
      printPayload(result, asJson, () => printBugSubmitResult(result));
      return result;
    });
  }

  @Command({
    name: "status",
    aliases: ["show"],
    description: "Show one of your Console bug reports",
    helpAfter: BUG_STATUS_HELP,
  })
  @CommandAccess({ kind: "read", resource: "bug", action: "status", risk: "low" })
  async status(
    @Arg("id", { description: "Bug report id" }) id: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return runBugCommand(asJson, async () => {
      const result = await getBugReportStatus(id, { console: consoleUrl }, this.deps);
      printPayload(result, asJson, () => printBugStatusResult(result));
      return result;
    });
  }

  @Command({
    name: "list",
    description: "List your Console bug reports",
    helpAfter: BUG_LIST_HELP,
  })
  @CommandAccess({ kind: "read", resource: "bug", action: "list", risk: "low" })
  async list(
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--limit <n>", description: "Maximum reports to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of reports to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each item" })
    fields?: string,
  ) {
    return runBugCommand(asJson, async () => {
      const parsedLimit = Number.parseInt(String(limit ?? "50"), 10);
      const parsedOffset = Number.parseInt(String(offset ?? "0"), 10);
      const result = await listBugReports(
        {
          console: consoleUrl,
          limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
          offset: Number.isFinite(parsedOffset) ? parsedOffset : undefined,
        },
        this.deps,
      );
      const page = paginateCliItems(result.bugs, { limit, offset });
      const pagination = buildCliOffsetPagination({
        fields,
        baseCommand: ["ravi", "bug", "list"],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: [consoleUrl ? "--console" : null, consoleUrl],
      });
      const items = pickFields(page.items, fields);
      const payload = {
        ...result,
        total: page.total,
        pagination,
        bugs: items,
        items,
      };
      printPayload(payload, asJson, () => printBugList(payload));
      return payload;
    });
  }
}

declareCommandReturns(BugCommands, {
  report: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    bug: jsonObjectSchema,
    id: z.string(),
    url: z.string(),
  }),
  status: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    bug: jsonObjectSchema,
    id: z.string(),
    url: z.string(),
  }),
  list: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    bugs: z.array(jsonObjectSchema),
    items: z.array(jsonObjectSchema),
  }),
});

function assembleDossier(input: {
  title?: string;
  summary?: string;
  severity?: string;
  surface?: string;
  dossierJson?: string;
  dossierFile?: string;
  requireComplete: boolean;
}): Partial<BugReportDossier> | undefined {
  if (input.dossierJson?.trim() && input.dossierFile?.trim()) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Use only one of --dossier-json or --dossier-file.");
  }

  const suppliedDossier = input.dossierFile?.trim()
    ? parseBugReportDossierJson(readDossierFile(input.dossierFile), "--dossier-file")
    : input.dossierJson?.trim()
      ? parseBugReportDossierJson(input.dossierJson, "--dossier-json")
      : undefined;

  const merged: Record<string, unknown> = isRecord(suppliedDossier) ? { ...suppliedDossier } : {};
  if (input.title?.trim()) merged.title = input.title.trim();
  if (input.summary?.trim()) merged.summary = input.summary.trim();
  if (input.severity !== undefined) merged.severity = normalizeBugReportSeverity(input.severity);
  if (input.surface?.trim()) merged.surface = input.surface.trim();

  const hasSuppliedDossier = suppliedDossier !== undefined;
  const hasFlagContent = Boolean(
    input.title?.trim() || input.summary?.trim() || input.severity || input.surface?.trim(),
  );
  if (!hasSuppliedDossier && !hasFlagContent) {
    if (input.requireComplete) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        "Missing bug dossier. Collect evidence first (`ravi bug report`), then re-run with --dossier-json and --execute.",
      );
    }
    normalizeBugReportSeverity(input.severity);
    return undefined;
  }

  if (hasSuppliedDossier || input.requireComplete) {
    return validateBugReportDossier(merged);
  }

  normalizeBugReportSeverity(input.severity);
  return {
    schemaVersion: BUG_REPORT_SCHEMA_ID,
    title: typeof merged.title === "string" ? merged.title : undefined,
    summary: typeof merged.summary === "string" ? merged.summary : undefined,
    severity: typeof merged.severity === "string" ? normalizeBugReportSeverity(merged.severity) : undefined,
    surface: typeof merged.surface === "string" ? merged.surface : undefined,
  };
}

function readDossierFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Cannot read --dossier-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function runBugCommand<T>(_asJson: boolean | undefined, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw cloudAuthErrorFromUnknown(error);
  }
}

function printPayload(payload: unknown, asJson: boolean | undefined, printHuman: () => void): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printHuman();
}

function printBugSubmitResult(result: BugReportSubmitResult): void {
  console.log(`Bug reported: ${result.id}`);
  console.log(`Tracking: ${result.url}`);
}

function printBugStatusResult(result: BugReportStatusResult): void {
  const status = stringValue(result.bug.status) ?? "unknown";
  const title = stringValue(result.bug.title);
  console.log(`Bug ${result.id}  status=${status}${title ? `  ${title}` : ""}`);
  console.log(`Tracking: ${result.url}`);
}

function printBugList(
  result: BugReportListResult & {
    items: Record<string, unknown>[];
    total: number;
    pagination?: { limit: number; nextCommand: string | null; offset: number };
  },
): void {
  if (result.items.length === 0) {
    console.log("No bug reports found.");
    return;
  }
  const pagination = result.pagination;
  console.log(
    `Bug reports (${result.items.length} returned of ${result.total}${
      pagination ? `, limit ${pagination.limit}, offset ${pagination.offset}` : ""
    })`,
  );
  for (const bug of result.items) {
    const id = stringValue(bug.id) ?? stringValue(bug.bugId) ?? "bug";
    const status = stringValue(bug.status);
    const title = stringValue(bug.title);
    const severity = stringValue(bug.severity);
    console.log(
      `  - ${[id, status ? `status=${status}` : null, severity ? `severity=${severity}` : null, title]
        .filter(Boolean)
        .join("  ")}`,
    );
  }
  if (pagination?.nextCommand) {
    console.log("\nNext page:");
    console.log(`  ${pagination.nextCommand}`);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

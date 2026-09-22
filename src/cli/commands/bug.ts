import "reflect-metadata";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { ContractError, contractDryRun, pickFields } from "../agent-contract.js";
import { CloudAuthError, cloudAuthErrorFromUnknown } from "../../cloud-auth/errors.js";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import {
  bugCommentIdempotencyKey,
  commentBugReport,
  getBugReportStatus,
  listBugReports,
  submitBugReport,
  type BugReportClientDeps,
  type BugReportCommentResult,
  type BugReportListResult,
  type BugReportStatusResult,
  type BugReportSubmitResult,
} from "../../bug-report/client.js";
import type { BugReportFollowResult } from "../../bug-report/follow.js";
import { BUG_COMMENT_COLLECTION_PROMPT, BUG_REPORT_COLLECTION_PROMPT } from "../../bug-report/prompt.js";
import { sanitizeBugCommentDossier } from "../../bug-report/sanitize.js";
import {
  BUG_COMMENT_SCHEMA_ID,
  BUG_REPORT_SCHEMA_ID,
  type BugCommentDossier,
  type BugReportDossier,
  type BugReportEvidence,
  bugCommentHasContent,
  normalizeBugReportSeverity,
  parseBugCommentDossierJson,
  parseBugReportDossierJson,
  requireCompleteBugCommentDossier,
  requireCompleteBugReportDossier,
  summarizeBugCommentPlan,
  summarizeBugReportPlan,
  validateBugCommentDossier,
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
  ravi bug comment bug_123 --text "Root cause is X" --execute --json
  ravi bug status bug_123 --json
  ravi bug list --json --limit 20

ON ERROR
  WRITE_REQUIRES_EXECUTE (exit 3) → fill the printed schema, confirm, add --execute
  PAYLOAD_INVALID (exit 2) → fix severity / dossier JSON / missing title+summary
  AUTH_REQUIRED (exit 1) → ravi login   (dry-run never needs this)

PIPELINE
  hit a bug → ask user → ravi bug report (collect) → sanitize → --execute → auto-follow (subscribe + per-bug trigger) → later evidence → ravi bug comment <id> → status/list

SEE ALSO
  ravi bug comment <id> — append follow-up evidence to this report
  ravi feedback send — lightweight inbox, not this dossier
  ravi specs get cli/bug-report --mode rules --json

FORMAT
  Dossier JSON object. Console path is POST /api/cli/bugs (global, not org-scoped).

FONTES
  .ravi/specs/cli/bug-report/SPEC.md
  src/cli/commands/bug.ts
  src/bug-report/client.ts
  src/bug-report/follow.ts
`;

const BUG_STATUS_HELP = `
USE          Look up one of your Console bug reports by id.
NÃO USE      ✗ guessing another user's id — this surface is "my reports"
EXAMPLES     ravi bug status bug_123 --json
ON ERROR     AUTH_REQUIRED → ravi login    not found → Console 404 / SERVER_UNAVAILABLE
SEE ALSO     ravi bug comment <id> --json
             ravi bug list --json
FONTES       .ravi/specs/cli/bug-report/SPEC.md
`;

const BUG_LIST_HELP = `
USE          List your own Console bug reports (global, not org-scoped).
NÃO USE      ✗ treating this as an org-wide inbox
EXAMPLES     ravi bug list --json --limit 20
             ravi bug list --json --fields id,title,severity --offset 20
ON ERROR     AUTH_REQUIRED → ravi login
SEE ALSO     ravi bug status <id> --json
             ravi bug comment <id> --json
FONTES       .ravi/specs/cli/bug-report/SPEC.md
`;

const BUG_COMMENT_HELP = `
USE
  Append sanitized follow-up text and/or evidence to an existing Console bug
  id. Keeps one report, one status feed, and one audit trail.

NÃO USE
  ✗ ravi bug report for later diagnosis on a bug you already filed
  ✗ --execute before the follow-up is sanitized and the user confirmed
  ✗ changing title, severity, priority, or status — this verb is append-only
  ✗ putting tokens, cookies, or private keys in --text or --evidence-file

REGRAS HARD
  • Dry-run by default (exit 3). Brake fires BEFORE ravi login / any POST.
  • Schema: ${BUG_COMMENT_SCHEMA_ID}
  • Required on submit: existing <id> plus --text and/or --evidence-file (or a comment dossier)
  • Sanitize first. The CLI redacts tokens/keys and records evidence.redactions / sanitization.rulesApplied.
  • Retries MUST reuse the same idempotency key. Default key is sha256 of this bug id plus the sanitized payload. Console is the idempotency ledger; the CLI does not store comments locally.

HITL OBRIGATÓRIO
  Ask the user if they want to append to this bug. Only --execute after they say yes.

EXAMPLES
  ravi bug comment bug_123 --json
  ravi bug comment bug_123 --text "Root cause is the idle-stdin TTY probe" --execute --json
  ravi bug comment bug_123 --text "Adding stack" --evidence-file ./stack.txt --execute --json
  ravi bug comment bug_123 --dossier-json '{"schemaVersion":"${BUG_COMMENT_SCHEMA_ID}","text":"More logs","evidence":{"notes":["reproduced on bun 1.3"]}}' --execute --json

ON ERROR
  WRITE_REQUIRES_EXECUTE (exit 3) → sanitize, confirm, add --execute
  PAYLOAD_INVALID (exit 2) → missing id / missing text+evidence / broken JSON / report dossier passed as comment
  AUTH_REQUIRED (exit 1) → ravi login   (dry-run never needs this)
  SERVER_UNAVAILABLE (exit 1) → Console missing POST /api/cli/bugs/<id>/comments; keep this id, do not file a second report

PIPELINE
  existing bug id → collect follow-up → sanitize → --execute → same id on status/list

SEE ALSO
  ravi bug report — file a new report
  ravi bug status <id> --json
  ravi specs get cli/bug-report --mode rules --json

FORMAT
  Comment JSON object. Console path is POST /api/cli/bugs/<id>/comments
  with Idempotency-Key. --evidence-file may be plain text (one note) or JSON
  {logs[], notes[], redactions[]} or a ${BUG_COMMENT_SCHEMA_ID} object.

FONTES
  .ravi/specs/cli/bug-report/SPEC.md
  src/cli/commands/bug.ts
  src/bug-report/client.ts
  src/bug-report/sanitize.ts
`;

@Group({
  name: "bug",
  aliases: ["bugs"],
  description: "File, comment on, and track global Ravi bug reports on Console",
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

  @Command({
    name: "comment",
    aliases: ["append"],
    description:
      "Append sanitized follow-up evidence or a comment to an existing Console bug report (dry-run by default; requires --execute)",
    helpAfter: BUG_COMMENT_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "bug", action: "comment", risk: "low", requiresConfirmation: true })
  async comment(
    @Arg("id", { description: "Existing bug report id" }) id: string,
    @Option({ flags: "--text <text>", description: "Sanitized follow-up comment" }) text?: string,
    @Option({
      flags: "--evidence-file <path>",
      description: "Path to sanitized evidence (plain text, evidence JSON, or a comment dossier)",
    })
    evidenceFile?: string,
    @Option({ flags: "--dossier-json <json>", description: `Full ${BUG_COMMENT_SCHEMA_ID} JSON object` })
    dossierJson?: string,
    @Option({ flags: "--dossier-file <path>", description: "Path to a comment dossier JSON file" })
    dossierFile?: string,
    @Option({
      flags: "--idempotency-key <key>",
      description: "Retry key; default is sha256 of this bug id plus the sanitized payload",
    })
    idempotencyKey?: string,
    @Option({ flags: "--console <url>", description: "Console base URL" }) consoleUrl?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description:
        "Actually POST the follow-up to Ravi Console; default is a dry-run that prints the collection prompt (exit 3)",
    })
    execute?: boolean,
  ) {
    return runBugCommand(asJson, async () => {
      const assembled = assembleComment({
        id,
        text,
        evidenceFile,
        dossierJson,
        dossierFile,
        requireComplete: execute === true,
      });
      if (execute !== true) {
        if (!asJson) {
          console.log(BUG_COMMENT_COLLECTION_PROMPT);
          console.log("");
        }
        // Write brake (Manual v2): POST /api/cli/bugs/:id/comments leaves the machine.
        contractDryRun(
          "bug comment",
          {
            ...summarizeBugCommentPlan(assembled.comment, {
              evidenceFilePresent: assembled.evidenceFilePresent,
              idempotencyKeyPresent: Boolean(idempotencyKey?.trim() || assembled.comment),
            }),
            collectionPrompt: BUG_COMMENT_COLLECTION_PROMPT,
          },
          { asJson },
        );
      }
      const comment = requireCompleteBugCommentDossier(assembled.comment);
      const result = await commentBugReport(
        {
          console: consoleUrl,
          id: assembled.bugId,
          comment,
          source: "cli",
          idempotencyKey: idempotencyKey?.trim() || bugCommentIdempotencyKey(assembled.bugId, comment),
        },
        this.deps,
      );
      printPayload(result, asJson, () => printBugCommentResult(result));
      return result;
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
    follow: z
      .object({
        ok: z.boolean(),
        subscribed: z.boolean(),
        triggerId: z.string().optional(),
        reused: z.boolean().optional(),
        topic: z.string(),
        filter: z.string(),
        session: z.literal("main"),
        warning: z.string().optional(),
      })
      .optional(),
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
  comment: z.object({
    success: z.literal(true),
    consoleUrl: z.string(),
    bug: jsonObjectSchema,
    comment: jsonObjectSchema,
    id: z.string(),
    bugId: z.string(),
    url: z.string(),
    reused: z.boolean(),
    idempotencyKey: z.string(),
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

const MAX_EVIDENCE_FILE_BYTES = 256 * 1024;

function assembleComment(input: {
  id: string;
  text?: string;
  evidenceFile?: string;
  dossierJson?: string;
  dossierFile?: string;
  requireComplete: boolean;
}): { bugId: string; comment?: BugCommentDossier; evidenceFilePresent: boolean } {
  const bugId = input.id.trim();
  if (!bugId) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Missing bug id.");
  }
  if (input.dossierJson?.trim() && input.dossierFile?.trim()) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Use only one of --dossier-json or --dossier-file.");
  }

  const suppliedDossier = input.dossierFile?.trim()
    ? parseBugCommentDossierJson(readDossierFile(input.dossierFile), "--dossier-file")
    : input.dossierJson?.trim()
      ? parseBugCommentDossierJson(input.dossierJson, "--dossier-json")
      : undefined;
  const evidenceFromFile = input.evidenceFile?.trim() ? readEvidenceFile(input.evidenceFile) : undefined;

  const merged: Record<string, unknown> = isRecord(suppliedDossier) ? { ...suppliedDossier } : {};
  if (evidenceFromFile?.comment) {
    const extra = evidenceFromFile.comment;
    if (extra.text?.trim() && !input.text?.trim() && typeof merged.text !== "string") merged.text = extra.text.trim();
    merged.evidence = mergeEvidence(
      isRecord(merged.evidence) ? (merged.evidence as BugReportEvidence) : undefined,
      extra.evidence,
    );
    if (extra.sanitization) merged.sanitization = extra.sanitization;
  } else if (evidenceFromFile?.evidence) {
    merged.evidence = mergeEvidence(
      isRecord(merged.evidence) ? (merged.evidence as BugReportEvidence) : undefined,
      evidenceFromFile.evidence,
    );
  }
  if (input.text?.trim()) merged.text = input.text.trim();

  const hasContent =
    Boolean(input.text?.trim()) ||
    evidenceFromFile !== undefined ||
    suppliedDossier !== undefined ||
    bugCommentHasContent(merged as Partial<BugCommentDossier>);
  if (!hasContent) {
    if (input.requireComplete) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        "Missing follow-up text or evidence. Collect and sanitize first (`ravi bug comment <id>`), then re-run with --text and/or --evidence-file plus --execute.",
      );
    }
    return { bugId, evidenceFilePresent: Boolean(input.evidenceFile?.trim()) };
  }

  const validated = validateBugCommentDossier(merged);
  const sanitized = sanitizeBugCommentDossier(validated);
  if (input.requireComplete) {
    return {
      bugId,
      comment: requireCompleteBugCommentDossier(sanitized),
      evidenceFilePresent: Boolean(input.evidenceFile?.trim()),
    };
  }
  return {
    bugId,
    comment: sanitized,
    evidenceFilePresent: Boolean(input.evidenceFile?.trim()),
  };
}

function readEvidenceFile(path: string): { comment?: BugCommentDossier; evidence?: BugReportEvidence } {
  let raw: string;
  try {
    const size = statSync(path).size;
    if (size > MAX_EVIDENCE_FILE_BYTES) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        `--evidence-file is larger than ${MAX_EVIDENCE_FILE_BYTES} bytes. Trim the file or split the follow-up.`,
      );
    }
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof CloudAuthError) throw error;
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Cannot read --evidence-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--evidence-file is empty.");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      const logs = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (!logs.length) throw new Error("JSON array must contain non-empty strings");
      return { evidence: { logs } };
    }
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      const schemaVersion = typeof record.schemaVersion === "string" ? record.schemaVersion.trim() : "";
      if (schemaVersion === BUG_REPORT_SCHEMA_ID) {
        throw new CloudAuthError(
          "PAYLOAD_INVALID",
          `--evidence-file looks like a ${BUG_REPORT_SCHEMA_ID} create dossier. Pass follow-up text/evidence, or use ravi bug comment --dossier-json with ${BUG_COMMENT_SCHEMA_ID}.`,
        );
      }
      if (schemaVersion === BUG_COMMENT_SCHEMA_ID || "text" in record) {
        return { comment: validateBugCommentDossier(record) };
      }
      if ("logs" in record || "notes" in record || "redactions" in record) {
        const evidence: BugReportEvidence = {};
        if (Array.isArray(record.logs)) evidence.logs = record.logs.filter(isNonEmptyString);
        if (Array.isArray(record.notes)) evidence.notes = record.notes.filter(isNonEmptyString);
        if (Array.isArray(record.redactions)) evidence.redactions = record.redactions.filter(isNonEmptyString);
        if (!evidence.logs?.length && !evidence.notes?.length) {
          throw new CloudAuthError("PAYLOAD_INVALID", "--evidence-file JSON needs logs[] and/or notes[].");
        }
        return { evidence };
      }
    }
  } catch (error) {
    if (error instanceof CloudAuthError) throw error;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      throw new CloudAuthError(
        "PAYLOAD_INVALID",
        `Invalid --evidence-file JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { evidence: { notes: [trimmed] } };
}

function mergeEvidence(
  left: BugReportEvidence | undefined,
  right: BugReportEvidence | undefined,
): BugReportEvidence | undefined {
  if (!left && !right) return undefined;
  const merged: BugReportEvidence = {
    logs: uniqueStrings([...(left?.logs ?? []), ...(right?.logs ?? [])]),
    notes: uniqueStrings([...(left?.notes ?? []), ...(right?.notes ?? [])]),
    redactions: uniqueStrings([...(left?.redactions ?? []), ...(right?.redactions ?? [])]),
  };
  if (!merged.logs?.length) delete merged.logs;
  if (!merged.notes?.length) delete merged.notes;
  if (!merged.redactions?.length) delete merged.redactions;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function uniqueStrings(values: string[]): string[] | undefined {
  const next = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return next.length > 0 ? next : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
  printBugFollowResult(result.follow);
}

function printBugFollowResult(follow: BugReportFollowResult | undefined): void {
  if (!follow) return;
  if (follow.ok && follow.triggerId) {
    console.log(
      `Following: trigger ${follow.triggerId} on ${follow.topic} (${follow.reused ? "reused" : "created"}, this bug only)`,
    );
    return;
  }
  const warning = follow.warning ?? "auto-follow did not finish";
  console.log(`Warning: bug was filed, but auto-follow failed: ${warning}`);
}

function printBugCommentResult(result: BugReportCommentResult): void {
  const verb = result.reused ? "already recorded (idempotent replay)" : "appended";
  console.log(`Bug comment ${verb}: ${result.id}`);
  console.log(`Bug: ${result.bugId}`);
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

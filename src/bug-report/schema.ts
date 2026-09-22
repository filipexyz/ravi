import { z } from "zod";
import { CloudAuthError } from "../cloud-auth/errors.js";

export const BUG_REPORT_SCHEMA_ID = "ravi.bug_report/v1";
export const BUG_COMMENT_SCHEMA_ID = "ravi.bug_comment/v1";
export const BUG_REPORT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export type BugReportSeverity = (typeof BUG_REPORT_SEVERITIES)[number];

export interface BugReportReproduction {
  steps?: string[];
  expected?: string;
  actual?: string;
  frequency?: string;
}

export interface BugReportEnvironment {
  raviVersion?: string;
  os?: string;
  runtime?: string;
  agentNames?: string[];
}

export interface BugReportEvidence {
  logs?: string[];
  notes?: string[];
  redactions?: string[];
}

export interface BugReportContext {
  organizationRef?: string;
  projectRef?: string;
  sessionHints?: string;
}

export interface BugReportSanitization {
  rulesApplied?: string[];
}

export interface BugReportDossier {
  schemaVersion: typeof BUG_REPORT_SCHEMA_ID;
  title: string;
  summary: string;
  severity: BugReportSeverity;
  surface?: string;
  reproduction?: BugReportReproduction;
  environment?: BugReportEnvironment;
  evidence?: BugReportEvidence;
  context?: BugReportContext;
  sanitization?: BugReportSanitization;
}

export interface BugCommentDossier {
  schemaVersion: typeof BUG_COMMENT_SCHEMA_ID;
  text?: string;
  evidence?: BugReportEvidence;
  sanitization?: BugReportSanitization;
}

const optionalText = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal("").transform(() => undefined));

const optionalStringList = z.array(z.string().trim().min(1)).optional();

export const bugReportSeveritySchema = z.enum(BUG_REPORT_SEVERITIES);

export const bugReportDossierSchema = z.object({
  schemaVersion: z.literal(BUG_REPORT_SCHEMA_ID).default(BUG_REPORT_SCHEMA_ID),
  title: z.string().trim().min(1, "title is required"),
  summary: z.string().trim().min(1, "summary is required"),
  severity: bugReportSeveritySchema,
  surface: optionalText,
  reproduction: z
    .object({
      steps: optionalStringList,
      expected: optionalText,
      actual: optionalText,
      frequency: optionalText,
    })
    .strict()
    .optional(),
  environment: z
    .object({
      raviVersion: optionalText,
      os: optionalText,
      runtime: optionalText,
      agentNames: optionalStringList,
    })
    .strict()
    .optional(),
  evidence: z
    .object({
      logs: optionalStringList,
      notes: optionalStringList,
      redactions: optionalStringList,
    })
    .strict()
    .optional(),
  context: z
    .object({
      organizationRef: optionalText,
      projectRef: optionalText,
      sessionHints: optionalText,
    })
    .strict()
    .optional(),
  sanitization: z
    .object({
      rulesApplied: optionalStringList,
    })
    .strict()
    .optional(),
});

export const bugCommentDossierSchema = z.object({
  schemaVersion: z.literal(BUG_COMMENT_SCHEMA_ID).default(BUG_COMMENT_SCHEMA_ID),
  text: optionalText,
  evidence: z
    .object({
      logs: optionalStringList,
      notes: optionalStringList,
      redactions: optionalStringList,
    })
    .strict()
    .optional(),
  sanitization: z
    .object({
      rulesApplied: optionalStringList,
    })
    .strict()
    .optional(),
});

export function normalizeBugReportSeverity(value: string | undefined): BugReportSeverity | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if ((BUG_REPORT_SEVERITIES as readonly string[]).includes(normalized)) {
    return normalized as BugReportSeverity;
  }
  throw new CloudAuthError("PAYLOAD_INVALID", `--severity must be one of: ${BUG_REPORT_SEVERITIES.join(", ")}.`);
}

export function parseBugReportDossierJson(value: string, label = "--dossier-json"): unknown {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("value must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateBugReportDossier(value: unknown): BugReportDossier {
  const parsed = bugReportDossierSchema.safeParse(normalizeIncomingDossier(value));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "dossier";
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid bug dossier (${path}): ${issue?.message ?? "invalid"}.`);
  }
  return parsed.data;
}

export function requireCompleteBugReportDossier(dossier: Partial<BugReportDossier> | undefined): BugReportDossier {
  if (!dossier) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing bug dossier. Collect evidence first (`ravi bug report`), then re-run with --dossier-json and --execute.",
    );
  }
  return validateBugReportDossier(dossier);
}

function normalizeIncomingDossier(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const schemaVersion = typeof record.schemaVersion === "string" ? record.schemaVersion.trim() : "";
  if (!schemaVersion) {
    record.schemaVersion = BUG_REPORT_SCHEMA_ID;
  } else if (schemaVersion !== BUG_REPORT_SCHEMA_ID) {
    throw new CloudAuthError("PAYLOAD_INVALID", `schemaVersion must be ${BUG_REPORT_SCHEMA_ID}.`);
  }
  if (typeof record.severity === "string") {
    record.severity = normalizeBugReportSeverity(record.severity);
  }
  return record;
}

export function summarizeBugReportPlan(dossier: Partial<BugReportDossier> | undefined): Record<string, unknown> {
  const evidence = dossier?.evidence;
  const environment = dossier?.environment;
  const context = dossier?.context;
  return {
    schemaVersion: BUG_REPORT_SCHEMA_ID,
    titlePresent: Boolean(dossier?.title?.trim()),
    summaryChars: dossier?.summary?.length ?? 0,
    severity: dossier?.severity ?? null,
    surface: dossier?.surface?.trim() || null,
    reproductionPresent: Boolean(dossier?.reproduction),
    environmentKeys: environment ? Object.keys(environment).sort() : [],
    evidenceCounts: {
      logs: evidence?.logs?.length ?? 0,
      notes: evidence?.notes?.length ?? 0,
      redactions: evidence?.redactions?.length ?? 0,
    },
    organizationRefPresent: Boolean(context?.organizationRef?.trim()),
    projectRefPresent: Boolean(context?.projectRef?.trim()),
    sessionHintsPresent: Boolean(context?.sessionHints?.trim()),
    sanitizationRulesCount: dossier?.sanitization?.rulesApplied?.length ?? 0,
  };
}

export function parseBugCommentDossierJson(value: string, label = "--dossier-json"): unknown {
  return parseBugReportDossierJson(value, label);
}

export function validateBugCommentDossier(value: unknown): BugCommentDossier {
  const parsed = bugCommentDossierSchema.safeParse(normalizeIncomingComment(value));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "comment";
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid bug comment (${path}): ${issue?.message ?? "invalid"}.`);
  }
  return parsed.data;
}

export function requireCompleteBugCommentDossier(comment: Partial<BugCommentDossier> | undefined): BugCommentDossier {
  if (!comment) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing follow-up text or evidence. Collect and sanitize first (`ravi bug comment <id>`), then re-run with --text and/or --evidence-file plus --execute.",
    );
  }
  const validated = validateBugCommentDossier(comment);
  if (!bugCommentHasContent(validated)) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing follow-up text or evidence. Provide --text and/or --evidence-file (or a comment dossier with those fields).",
    );
  }
  return validated;
}

export function bugCommentHasContent(comment: Partial<BugCommentDossier> | undefined): boolean {
  if (comment?.text?.trim()) return true;
  const evidence = comment?.evidence;
  return Boolean(evidence?.logs?.length || evidence?.notes?.length);
}

export function summarizeBugCommentPlan(
  comment: Partial<BugCommentDossier> | undefined,
  extras: { evidenceFilePresent?: boolean; idempotencyKeyPresent?: boolean } = {},
): Record<string, unknown> {
  const evidence = comment?.evidence;
  return {
    schemaVersion: BUG_COMMENT_SCHEMA_ID,
    textPresent: Boolean(comment?.text?.trim()),
    textChars: comment?.text?.length ?? 0,
    evidenceFilePresent: extras.evidenceFilePresent === true,
    evidenceCounts: {
      logs: evidence?.logs?.length ?? 0,
      notes: evidence?.notes?.length ?? 0,
      redactions: evidence?.redactions?.length ?? 0,
    },
    sanitizationRulesCount: comment?.sanitization?.rulesApplied?.length ?? 0,
    idempotencyKeyPresent: extras.idempotencyKeyPresent === true,
  };
}

function normalizeIncomingComment(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  const schemaVersion = typeof record.schemaVersion === "string" ? record.schemaVersion.trim() : "";
  if (!schemaVersion) {
    record.schemaVersion = BUG_COMMENT_SCHEMA_ID;
  } else if (schemaVersion === BUG_REPORT_SCHEMA_ID) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `schemaVersion ${BUG_REPORT_SCHEMA_ID} is a create dossier. Use ${BUG_COMMENT_SCHEMA_ID} with --text/--evidence-file, or file a new report with ravi bug report.`,
    );
  } else if (schemaVersion !== BUG_COMMENT_SCHEMA_ID) {
    throw new CloudAuthError("PAYLOAD_INVALID", `schemaVersion must be ${BUG_COMMENT_SCHEMA_ID}.`);
  }
  return record;
}

import type { BugCommentDossier, BugReportEvidence, BugReportSanitization } from "./schema.js";

export const BUG_SANITIZE_RULES = {
  bearer: "redact-bearer-tokens",
  apiToken: "redact-api-tokens",
  rctx: "redact-rctx-tokens",
  assignment: "redact-secret-assignments",
  keyValue: "redact-secret-key-values",
  privateKey: "redact-private-keys",
} as const;

const REDACTED = "[REDACTED]";

export interface SanitizeTextResult {
  value: string;
  redacted: boolean;
  rulesApplied: string[];
}

export function sanitizeBugReportText(value: string): SanitizeTextResult {
  const rulesApplied: string[] = [];
  let next = value;

  next = replaceAndRecord(
    next,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => `${REDACTED}:private-key`,
    BUG_SANITIZE_RULES.privateKey,
    rulesApplied,
  );
  next = replaceAndRecord(
    next,
    /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|COOKIE|AUTHORIZATION|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|CONTEXT_KEY)[A-Z0-9_]*)=([^\s"']+)/g,
    (_match, key: string) => `${key}=${REDACTED}`,
    BUG_SANITIZE_RULES.assignment,
    rulesApplied,
  );
  next = replaceAndRecord(
    next,
    /(?:authorization\s*[:=]\s*)bearer\s+[^\s,;]+/gi,
    (match) => match.replace(/bearer\s+[^\s,;]+/i, `Bearer ${REDACTED}`),
    BUG_SANITIZE_RULES.bearer,
    rulesApplied,
  );
  next = replaceAndRecord(
    next,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    () => `Bearer ${REDACTED}`,
    BUG_SANITIZE_RULES.bearer,
    rulesApplied,
  );
  next = replaceAndRecord(
    next,
    /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|authorization|cookie|context[_-]?key)["']?\s*[:=]\s*["']?)([^\s"'}]+)(["']?)/gi,
    (_match, prefix: string, _secret: string, suffix = "") => `${prefix}${REDACTED}${suffix}`,
    BUG_SANITIZE_RULES.keyValue,
    rulesApplied,
  );
  next = replaceAndRecord(
    next,
    /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
    () => `${REDACTED}:token`,
    BUG_SANITIZE_RULES.apiToken,
    rulesApplied,
  );
  next = replaceAndRecord(
    next,
    /rctx_[A-Za-z0-9_-]+/g,
    () => `${REDACTED}:rctx`,
    BUG_SANITIZE_RULES.rctx,
    rulesApplied,
  );

  return { value: next, redacted: rulesApplied.length > 0, rulesApplied };
}

export function sanitizeBugReportEvidence(evidence: BugReportEvidence | undefined): {
  evidence: BugReportEvidence | undefined;
  rulesApplied: string[];
} {
  if (!evidence) return { evidence: undefined, rulesApplied: [] };
  const rules = new Set<string>();
  const logs = sanitizeStringList(evidence.logs, rules);
  const notes = sanitizeStringList(evidence.notes, rules);
  const redactions = uniqueStrings([
    ...(evidence.redactions ?? []),
    ...(rules.size > 0 ? ["secret material in evidence"] : []),
  ]);
  const next: BugReportEvidence = {};
  if (logs?.length) next.logs = logs;
  if (notes?.length) next.notes = notes;
  if (redactions.length) next.redactions = redactions;
  return {
    evidence: Object.keys(next).length > 0 ? next : undefined,
    rulesApplied: [...rules],
  };
}

export function sanitizeBugCommentDossier(comment: BugCommentDossier): BugCommentDossier {
  const textResult = comment.text ? sanitizeBugReportText(comment.text) : undefined;
  const evidenceResult = sanitizeBugReportEvidence(comment.evidence);
  const rulesApplied = uniqueStrings([
    ...(comment.sanitization?.rulesApplied ?? []),
    ...(textResult?.rulesApplied ?? []),
    ...evidenceResult.rulesApplied,
  ]);
  const redactions = uniqueStrings([
    ...(evidenceResult.evidence?.redactions ?? []),
    ...(textResult?.redacted ? ["secret material in comment text"] : []),
  ]);
  const sanitization: BugReportSanitization | undefined = rulesApplied.length ? { rulesApplied } : comment.sanitization;
  const evidence =
    evidenceResult.evidence || redactions.length
      ? {
          ...(evidenceResult.evidence ?? {}),
          ...(redactions.length ? { redactions } : {}),
        }
      : undefined;
  return {
    schemaVersion: comment.schemaVersion,
    ...(textResult?.value.trim() ? { text: textResult.value.trim() } : {}),
    ...(evidence ? { evidence } : {}),
    ...(sanitization ? { sanitization } : {}),
  };
}

function sanitizeStringList(values: string[] | undefined, rules: Set<string>): string[] | undefined {
  if (!values?.length) return undefined;
  return values.map((value) => {
    const result = sanitizeBugReportText(value);
    for (const rule of result.rulesApplied) rules.add(rule);
    return result.value;
  });
}

function replaceAndRecord(
  value: string,
  pattern: RegExp,
  replacement: (substring: string, ...args: string[]) => string,
  rule: string,
  rulesApplied: string[],
): string {
  const next = value.replace(pattern, (...args) => replacement(args[0] ?? "", ...(args.slice(1) as string[])));
  if (next !== value && !rulesApplied.includes(rule)) rulesApplied.push(rule);
  return next;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

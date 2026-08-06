/**
 * Manual v2 CLI contract helpers for `ravi crm` (implemented at the source,
 * not as an emulation layer):
 *
 *  - Error envelope: with `--json`, failures print
 *    `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`
 *    on stdout — never plain text.
 *  - Exit taxonomy (official): 0 success · 1 execution/not-found/provider error ·
 *    2 usage error (invalid flag/arg, carries `acceptedFlags`) · 3 blocked by
 *    policy (write brake / dry-run). 3 is NOT an error — it is the system working.
 *  - Write brake (7.8): mutating ops are dry-run by default; `--execute` performs
 *    the real write (model: `ravi sessions prune`).
 *  - Compact mode (7.9): listings accept `--fields a,b,c`.
 *
 * Behavior in tool/test context (`hasContext()` true, e.g. daemon or bun tests):
 * instead of printing + exiting, a `CrmContractError` is thrown carrying the same
 * envelope and exit code, so callers can assert without killing the process.
 */
import { fail, hasContext } from "../context.js";

export const CRM_EXIT_ERROR = 1;
export const CRM_EXIT_USAGE = 2;
export const CRM_EXIT_POLICY = 3;

export interface CrmErrorDetails {
  retryable?: boolean;
  suggestedAction?: string;
  suggestions?: string[];
  acceptedFlags?: string[];
  [key: string]: unknown;
}

export interface CrmErrorEnvelope {
  success: false;
  op: string;
  error: { code: string; message: string; retryable: boolean } & CrmErrorDetails;
}

export class CrmContractError extends Error {
  readonly op: string;
  readonly code: string;
  readonly exitCode: number;
  readonly details: CrmErrorDetails;

  constructor(op: string, code: string, message: string, exitCode: number, details: CrmErrorDetails = {}) {
    super(message);
    this.name = "CrmContractError";
    this.op = op;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }

  envelope(): CrmErrorEnvelope {
    const { retryable, ...rest } = this.details;
    return {
      success: false,
      op: this.op,
      error: { code: this.code, message: this.message, retryable: retryable ?? false, ...rest },
    };
  }
}

export interface CrmFailOptions {
  asJson?: boolean;
  exitCode?: number;
  details?: CrmErrorDetails;
}

/**
 * Fail a CRM command under the Manual v2 contract.
 * The legacy text path (non-JSON, exit 1) still delegates to `fail()` so
 * existing behavior and test mocks keep working unchanged.
 */
export function crmFail(op: string, code: string, message: string, options: CrmFailOptions = {}): never {
  const exitCode = options.exitCode ?? CRM_EXIT_ERROR;
  if (!options.asJson && exitCode === CRM_EXIT_ERROR) {
    fail(message);
  }
  const error = new CrmContractError(op, code, message, exitCode, options.details ?? {});
  if (options.asJson) {
    console.log(JSON.stringify(error.envelope(), null, 2));
  } else {
    console.error(message);
  }
  if (hasContext()) throw error;
  process.exit(exitCode);
}

/**
 * Write brake (freio): emit the dry-run plan and exit 3 BEFORE any write/DB
 * mutation. The planned input is shown so the agent can inspect exactly what
 * `--execute` would do.
 */
export function crmDryRun(op: string, plan: Record<string, unknown>, options: { asJson?: boolean } = {}): never {
  const error = new CrmContractError(
    op,
    "WRITE_REQUIRES_EXECUTE",
    `Dry-run: nothing was written. Re-run with --execute to perform the write.`,
    CRM_EXIT_POLICY,
    {
      suggestedAction: `Re-run '${op}' adding --execute to perform the write`,
      dryRun: true,
      plan,
    },
  );
  if (options.asJson) {
    console.log(JSON.stringify(error.envelope(), null, 2));
  } else {
    console.log(`[dry-run] ${op}: nothing was written.`);
    console.log(`Planned input:`);
    console.log(JSON.stringify(plan, null, 2));
    console.log(`Re-run with --execute to perform the write.`);
  }
  if (hasContext()) throw error;
  process.exit(CRM_EXIT_POLICY);
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i++) out.push(value.slice(i, i + 2));
  return out;
}

function similarity(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.8;
  const ba = new Set(bigrams(a));
  const bb = bigrams(b);
  const intersection = bb.filter((x) => ba.has(x)).length;
  return (2 * intersection) / Math.max(1, bigrams(a).length + bb.length);
}

/**
 * Up to `max` real candidate entities most similar to `query` (Dice bigram
 * similarity, same ranking as the validated POC). Used to enrich NOT_FOUND
 * errors with actionable `suggestions`.
 */
export function suggestSimilar(query: string, candidates: Array<string | null | undefined>, max = 3): string[] {
  const unique = [...new Set(candidates.filter((c): c is string => typeof c === "string" && c.length > 0))];
  return unique
    .map((candidate) => ({ candidate, score: similarity(query, candidate) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((entry) => entry.candidate);
}

/**
 * Compact mode (7.9): keep only the requested top-level fields of each item.
 * Unknown fields are ignored; without `fields` the list passes through.
 */
export function pickFields<T>(items: T[], fields?: string): T[] {
  const keys = (fields ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (keys.length === 0) return items;
  return items.map((item) => {
    const record = item as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in record) picked[key] = record[key];
    }
    return picked as T;
  });
}

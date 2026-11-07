/**
 * Agent-first (Manual v2) CLI contract helpers, shared by every migrated
 * `ravi` domain (implemented at the source, not as an emulation layer):
 *
 *  - Error envelope: with `--json`, failures print
 *    `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`
 *    on stdout — never plain text.
 *  - Exit taxonomy (official): 0 success · 1 execution/not-found/provider error ·
 *    2 usage error (invalid flag/arg, carries `acceptedFlags`) · 3 blocked by
 *    policy (write brake / dry-run). 3 is NOT an error — it is the system working.
 *  - Risk brake: only externally consequential, irreversible, triggered or
 *    above-threshold operations dry-run by default; local reversible writes do
 *    not inherit a brake merely because they mutate.
 *  - Compact mode (7.9): listings accept `--fields a,b,c`.
 *
 * A `ContractError` is always thrown after rendering. Process, tool and gateway
 * adapters own exit/status/audit translation so they can flush one consistent
 * outcome before the process ends.
 */
import { stripVTControlCharacters } from "node:util";
import type { Command as CommanderCommand, CommanderError } from "commander";
import { isSqliteCapacityError, SQLITE_CAPACITY_USER_MESSAGE } from "../db/write-retry.js";
import { isRuntimeContextError } from "../runtime/context-errors.js";
import { getContext } from "./context.js";
import { CliExpectedError } from "./expected-error.js";
import {
  errorDiagnostic,
  projectDiagnosticContext,
  redactDiagnosticText,
  type ErrorDiagnostic,
} from "../utils/error-diagnostic.js";
export { errorDiagnostic } from "../utils/error-diagnostic.js";
import { sanitizePublicValue } from "./redaction.js";
import { safeDiagnosticField } from "../../packages/ravi-os-sdk/src/diagnostic-redactor.js";

export const GENERIC_COMMAND_FAILED_MESSAGE = "Command could not be completed.";
const MAX_PUBLIC_CONTRACT_MESSAGE_LENGTH = 4096;

export const CONTRACT_EXIT_ERROR = 1;
export const CONTRACT_EXIT_USAGE = 2;
export const CONTRACT_EXIT_POLICY = 3;
type ContractExitCode = typeof CONTRACT_EXIT_ERROR | typeof CONTRACT_EXIT_USAGE | typeof CONTRACT_EXIT_POLICY;

export type ContractFailureOutcome = "blocked" | "usage_error" | "denied" | "failed";

export interface ContractErrorDetails {
  retryable?: boolean;
  suggestedAction?: string;
  suggestions?: string[];
  acceptedFlags?: string[];
  [key: string]: unknown;
}

const PERMISSION_PROFILE_INSPECTION_COMMANDS = new Set([
  "ravi skills show permissions",
  "ravi tags list --kind system --source permissions --json",
]);

export function projectPermissionProfileInspectionCommands(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const commands = [
    ...new Set(
      value.filter(
        (item): item is string => typeof item === "string" && PERMISSION_PROFILE_INSPECTION_COMMANDS.has(item),
      ),
    ),
  ].slice(0, 8);
  return commands.length ? commands : undefined;
}

export interface ContractErrorEnvelope {
  success: false;
  op: string;
  error: { code: string; message: string; retryable: boolean } & ContractErrorDetails;
}

/** Existing control contracts are explicit; arbitrary exception properties are not controls. */
const CONTROL_FIELDS = [
  "retryable",
  "suggestedAction",
  "suggestions",
  "acceptedFlags",
  "acceptedPositionals",
  "acceptedValues",
  "usage",
  "dryRun",
  "plan",
  "status",
  "requestId",
  "diagnosticRequestId",
  "field",
  "argument",
  "issues",
  "capability",
  "requiredCapability",
  "missingCapability",
  "denialStage",
  "denialId",
  "domainSetup",
  "triggerIds",
  "conflict",
  "currentVersion",
  "refusal",
  "effectState",
  "written",
  "existing",
  "operation",
  "ownerPrincipal",
  "jobId",
  "refusalReason",
  "pipelineId",
  "timeoutSeconds",
  "mediaPathPresent",
  "visibility",
  "basesUses",
  "ruleCount",
  "totalGaps",
  "highSeverityGaps",
  "gaps",
  "offenders",
  "errors",
  "warnings",
  "files",
  "widgets",
  "options",
  "override",
  "turn",
  "linkFlow",
  "stage",
  "authorizationDecision",
  "limitBytes",
  "partial",
  "chatLine",
  "chatLinePt",
  "replyTo",
  "reconnectLink",
  "approvalId",
  "approvalLink",
  "expiresAt",
  "retryWith",
  "consentLink",
  "ref",
  "scope",
  "project",
  "viewProject",
  "archived",
  "view",
  "baseVersion",
  "latestVersion",
  "activeTurn",
  "turnId",
  "disabledReason",
] as const;

/** The contrast failure contract is bounded independently of diagnostic text. */
function projectContrastControl(
  value: unknown,
): { ok: boolean; failed: Array<{ pair: [string, string]; ratio: number; min: number }> } | undefined {
  const ok = safeDiagnosticField(value, "ok");
  const failed = safeDiagnosticField(value, "failed");
  if (typeof ok !== "boolean" || !Array.isArray(failed)) return undefined;
  const projected: Array<{ pair: [string, string]; ratio: number; min: number }> = [];
  for (const check of boundedControlItems(failed)) {
    const pair = safeDiagnosticField(check, "pair");
    const foreground = safeDiagnosticField(pair, "0");
    const background = safeDiagnosticField(pair, "1");
    const ratio = safeDiagnosticField(check, "ratio");
    const min = safeDiagnosticField(check, "min");
    if (
      !Array.isArray(pair) ||
      safeDiagnosticField(pair, "length") !== 2 ||
      typeof foreground !== "string" ||
      typeof background !== "string" ||
      typeof ratio !== "number" ||
      !Number.isFinite(ratio) ||
      ratio < 0 ||
      typeof min !== "number" ||
      !Number.isFinite(min) ||
      min < 0
    )
      continue;
    projected.push({
      pair: [redactDiagnosticText(foreground).slice(0, 160), redactDiagnosticText(background).slice(0, 160)],
      ratio,
      min,
    });
  }
  return { ok, failed: projected };
}

function operationalControlIdentifier(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) &&
    redactDiagnosticText(value) === value
  );
}

/** Read at most 32 values and never enumerate unrelated fields on provider objects. */
function boundedControlItems(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const length = safeDiagnosticField(value, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return [];
  return Array.from({ length: Math.min(length, 32) }, (_, index) => safeDiagnosticField(value, String(index)));
}

function projectCandidateControls(
  value: unknown,
): Array<{ installationId: string; name: string | null; online: boolean; reportedAt: string | null }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Array<{ installationId: string; name: string | null; online: boolean; reportedAt: string | null }> = [];
  for (const candidate of boundedControlItems(value)) {
    const installationId = safeDiagnosticField(candidate, "installationId");
    const name = safeDiagnosticField(candidate, "name");
    const online = safeDiagnosticField(candidate, "online");
    const reportedAt = safeDiagnosticField(candidate, "reportedAt");
    const validTimestamp =
      typeof reportedAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(reportedAt) &&
      Number.isFinite(Date.parse(reportedAt));
    if (
      !operationalControlIdentifier(installationId) ||
      typeof online !== "boolean" ||
      (name !== null && typeof name !== "string") ||
      (reportedAt !== null && !validTimestamp)
    )
      continue;
    result.push({
      installationId,
      name: name === null ? null : redactDiagnosticText(name).slice(0, 160),
      online,
      reportedAt: reportedAt as string | null,
    });
  }
  return result;
}

function projectDriftControls(
  value: unknown,
): boolean | Array<{ file: string; reason: string; path?: string }> | undefined {
  if (typeof value === "boolean") return value;
  if (!Array.isArray(value)) return undefined;
  const result: Array<{ file: string; reason: string; path?: string }> = [];
  for (const item of boundedControlItems(value)) {
    const file = safeDiagnosticField(item, "file");
    const reason = safeDiagnosticField(item, "reason");
    const path = safeDiagnosticField(item, "path");
    if (typeof file !== "string" || typeof reason !== "string") continue;
    const options = { secrets: typeof path === "string" && path ? [path] : [] };
    result.push({
      file: redactDiagnosticText(file, options).slice(0, 160),
      reason: redactDiagnosticText(reason, options).slice(0, 400),
      ...(typeof path === "string" ? { path: "[REDACTED:path]" } : {}),
    });
  }
  return result;
}

function projectHttpControlUrl(value: unknown, key: string): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\//i.test(value) || !URL.canParse(value))
    return undefined;
  const sanitized = sanitizePublicValue(value, key);
  return typeof sanitized === "string" ? redactDiagnosticText(sanitized).slice(0, 2048) : undefined;
}

/** Domain controls describe the next action, never the underlying provider payload. */
function projectOperationalControls(details: unknown): Record<string, unknown> {
  const controls: Record<string, unknown> = {};
  const read = (key: string) => safeDiagnosticField(details, key);
  const contrast = projectContrastControl(read("contrast"));
  if (contrast) controls.contrast = contrast;
  const identifier = operationalControlIdentifier;
  const counter = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const consoleError = read("consoleError");
  if (typeof consoleError === "string" && /^[a-z][a-z0-9_]{0,95}$/.test(consoleError))
    controls.consoleError = consoleError;
  const inputsHash = read("inputsHash");
  if (typeof inputsHash === "string" && /^[0-9a-f]{16}$/i.test(inputsHash)) controls.inputsHash = inputsHash;
  const currentChat = read("currentChat");
  if (identifier(currentChat)) controls.currentChat = currentChat;
  const runId = read("runId");
  if (identifier(runId, 80)) controls.runId = runId;
  const proposalStatus = read("proposalStatus");
  if (
    typeof proposalStatus === "string" &&
    ["draft", "proposed", "published", "superseded", "rejected", "withdrawn"].includes(proposalStatus)
  )
    controls.proposalStatus = proposalStatus;
  if (read("routine") === "cron") controls.routine = "cron";
  if (read("reason") === "admin_context_exists") controls.reason = "admin_context_exists";
  for (const key of ["expectedSha", "actualSha"] as const) {
    const value = read(key);
    if (typeof value === "string" && /^[a-f0-9]{40}$/.test(value)) controls[key] = value;
  }
  const objectType = read("objectType");
  if (objectType === "blob" || objectType === "tree" || objectType === "commit") controls.objectType = objectType;
  const candidates = projectCandidateControls(read("candidates"));
  if (candidates) controls.candidates = candidates;
  const drift = projectDriftControls(read("drift"));
  if (drift !== undefined) controls.drift = drift;
  for (const key of ["dir", "path"] as const) if (typeof read(key) === "string") controls[key] = "[REDACTED:path]";
  const allowedKeys = read("allowedKeys");
  if (Array.isArray(allowedKeys))
    controls.allowedKeys = boundedControlItems(allowedKeys).filter(
      (value): value is string => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,95}$/.test(value),
    );
  for (const key of ["installUrl", "connectUrl"] as const) {
    const value = projectHttpControlUrl(read(key), key);
    if (value) controls[key] = value;
  }
  for (const key of ["missingPermissions", "missingCapabilities", "unsupportedEventTypes"] as const) {
    const value = read(key);
    if (Array.isArray(value))
      controls[key] = boundedControlItems(value).filter(
        (item): item is string =>
          typeof item === "string" &&
          /^[A-Za-z0-9_*][A-Za-z0-9_.:*/-]{0,159}$/.test(item) &&
          !item.includes("://") &&
          redactDiagnosticText(item) === item,
      );
  }
  for (const key of ["retryAfterMs", "schemaVersion", "liveBytes", "storedBytes"] as const) {
    const value = read(key);
    if (counter(value)) controls[key] = value;
  }
  const missingScopes = read("missingScopes");
  if (Array.isArray(missingScopes)) {
    const scopes = missingScopes
      .slice(0, 32)
      .filter(
        (value): value is string => identifier(value) && /^[a-z][a-z0-9_-]*(?:[.:][a-z][a-z0-9_-]*)+$/.test(value),
      );
    if (scopes.length) controls.missingScopes = scopes;
  }
  const current = read("current");
  const rowId = safeDiagnosticField(current, "rowId");
  const version = safeDiagnosticField(current, "version");
  if (identifier(rowId) && counter(version)) controls.current = { rowId, version };
  const name = safeDiagnosticField(read("organization"), "name");
  if (typeof name === "string" && name.trim())
    controls.organization = { name: redactDiagnosticText(name).slice(0, 200) };
  const progress = read("importProgress");
  if (progress && typeof progress === "object") {
    const projected: Record<string, number | null> = {};
    for (const key of ["failedBatch", "batches", "rowsCreated", "firstFailedLine"] as const) {
      const value = safeDiagnosticField(progress, key);
      if (counter(value) || (key === "firstFailedLine" && value === null)) projected[key] = value;
    }
    if (Object.keys(projected).length) controls.importProgress = projected;
  }
  return controls;
}

function projectFailureDetails(details: ContractErrorDetails & ErrorDiagnostic): ContractErrorDetails {
  const controls = projectOperationalControls(details);
  for (const field of CONTROL_FIELDS) {
    if (Object.hasOwn(details, field)) controls[field] = sanitizePublicValue(details[field], field);
  }
  const inspectCommands = projectPermissionProfileInspectionCommands(details.inspectCommands);
  if (inspectCommands) controls.inspectCommands = inspectCommands;
  if (details.acceptedValuesTruncated === true) controls.acceptedValuesTruncated = true;
  // Control text is also egress: retaining a known field does not make its value public.
  for (const field of ["suggestedAction", "usage", "diff"] as const) {
    if (typeof details[field] === "string") controls[field] = redactDiagnosticText(details[field]);
  }
  return {
    ...controls,
    cause: redactDiagnosticText(details.cause),
    context: projectDiagnosticContext(details.context),
  };
}

export class ContractError extends Error {
  readonly op: string;
  readonly code: string;
  readonly exitCode: number;
  readonly details: ContractErrorDetails;

  constructor(
    op: string,
    code: string,
    message: string,
    exitCode: number,
    details: ContractErrorDetails & ErrorDiagnostic,
  ) {
    if (!details || typeof details.cause !== "string" || !details.context || typeof details.context !== "object") {
      throw new TypeError("A user failure requires an explicit cause and diagnostic context.");
    }
    super(redactDiagnosticText(message));
    const canonicalExitCode = validateContractTaxonomy(code, exitCode);
    this.name = "ContractError";
    this.op =
      op.length <= 160 && /^[a-z][a-z0-9._-]*(?: [a-z][a-z0-9._-]*)*$/i.test(op) && redactDiagnosticText(op) === op
        ? op
        : "command";
    this.code =
      /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(code) && redactDiagnosticText(code) === code ? code : "COMMAND_FAILED";
    this.exitCode = canonicalExitCode;
    this.details = projectFailureDetails(details);
  }

  envelope(): ContractErrorEnvelope {
    const { retryable, ...rest } = this.details;
    return {
      success: false,
      op: this.op,
      error: {
        code: this.code,
        message: publicContractMessage(this.code, this.message),
        retryable: retryable ?? false,
        ...rest,
      },
    };
  }
}

function validateContractTaxonomy(code: string, exitCode: number): ContractExitCode {
  if (exitCode !== CONTRACT_EXIT_ERROR && exitCode !== CONTRACT_EXIT_USAGE && exitCode !== CONTRACT_EXIT_POLICY) {
    throw new Error("Invalid CLI contract exit taxonomy");
  }
  if (code === "PERMISSION_DENIED" && exitCode !== CONTRACT_EXIT_ERROR) {
    throw new Error("Invalid CLI contract exit taxonomy");
  }
  if (code === "WRITE_REQUIRES_EXECUTE" && exitCode !== CONTRACT_EXIT_POLICY) {
    throw new Error("Invalid CLI contract exit taxonomy");
  }
  if (code === "USAGE_ERROR" && exitCode !== CONTRACT_EXIT_USAGE) {
    throw new Error("Invalid CLI contract exit taxonomy");
  }
  return exitCode;
}

export function contractFailureOutcome(error: Pick<ContractError, "code" | "exitCode">): ContractFailureOutcome {
  if (error.exitCode === CONTRACT_EXIT_POLICY) return "blocked";
  if (error.exitCode === CONTRACT_EXIT_USAGE) return "usage_error";
  if (error.code === "PERMISSION_DENIED") return "denied";
  return "failed";
}

export function expectedErrorToContractError(op: string, error: unknown): ContractError | null {
  if (!(error instanceof CliExpectedError)) return null;
  // Existing fail() handlers share this grammar. Classify it at the common
  // boundary so every missing-flag refusal has the same field/exit contract.
  const required = /^(--[a-z][a-z0-9-]{0,63}) is required\.?$/.exec(error.message.trim());
  if (error.code === "COMMAND_FAILED" && required) {
    const argument = required[1]!;
    const field = argument.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    return new ContractError(op, "VALIDATION_ERROR", `${argument} is required.`, CONTRACT_EXIT_USAGE, {
      ...errorDiagnostic(error, { operation: op }),
      ...{
        argument,
        field,
        issues: [{ path: [field], code: "required", message: `${argument} is required.` }],
        suggestedAction:
          sanitizePublicContractMessage(error.suggestedAction) ?? `Provide ${argument} and retry '${op}'`,
      },
    });
  }
  const message = sanitizePublicContractMessage(error.message) ?? GENERIC_COMMAND_FAILED_MESSAGE;
  const suggestedAction =
    sanitizePublicContractMessage(error.suggestedAction) ?? `Inspect the command input and retry '${op}'`;
  return new ContractError(op, error.code, message, error.exitCode, {
    ...errorDiagnostic(error, { operation: op }),
    ...{
      suggestedAction,
    },
  });
}

export function unexpectedErrorToContractError(op: string, error?: unknown): ContractError {
  return new ContractError(
    op,
    "UNHANDLED_ERROR",
    `${op} failed internally. Report the operation to the operator before retrying.`,
    CONTRACT_EXIT_ERROR,
    {
      ...errorDiagnostic(error, { operation: op }),
      suggestedAction: "Report the operation to the operator; do not automatically retry the command",
    },
  );
}

export function runtimeContextErrorToContractError(op: string, error: unknown): ContractError | null {
  if (!isRuntimeContextError(error)) return null;
  return new ContractError(op, error.code, error.message, error.exitCode, {
    ...errorDiagnostic(error, { operation: op }),
    ...{
      suggestedAction: error.suggestedAction,
      ...error.details,
    },
  });
}

export function sqliteCapacityToContractError(op: string, error: unknown): ContractError | null {
  if (!isSqliteCapacityError(error)) return null;
  return new ContractError(op, "SQLITE_CAPACITY", SQLITE_CAPACITY_USER_MESSAGE, CONTRACT_EXIT_ERROR, {
    ...errorDiagnostic(error, { operation: op }),
    ...{
      retryable: false,
      suggestedAction:
        "Reduce concurrent sessions and retry. A large SQLite file can OOM the process even when disk is free. Vacuum is an operator maintenance step, not a product default.",
    },
  });
}

export function mapExecutionErrorToContractError(op: string, error: unknown): ContractError {
  return (
    expectedErrorToContractError(op, error) ??
    runtimeContextErrorToContractError(op, error) ??
    sqliteCapacityToContractError(op, error) ??
    unexpectedErrorToContractError(op, error)
  );
}

export function permissionDeniedToContractError(
  op: string,
  reason: string,
  details: ContractErrorDetails = {},
): ContractError {
  return new ContractError(op, "PERMISSION_DENIED", reason, CONTRACT_EXIT_ERROR, {
    ...errorDiagnostic(reason, { operation: op }),
    suggestedAction: "Request the required provider-owned permission and retry",
    ...details,
  });
}

export function binaryResponseToContractError(op: string, status: number): ContractError {
  const details = { status, suggestedAction: "Inspect the binary resource identifier and retry" };
  if (status === 400) {
    return new ContractError(op, "USAGE_ERROR", "Binary resource request was invalid.", CONTRACT_EXIT_USAGE, {
      ...errorDiagnostic("Binary resource request was invalid.", { operation: op }),
      ...details,
    });
  }
  if (status === 401) {
    return new ContractError(op, "AUTH_REQUIRED", "Binary resource authentication failed.", CONTRACT_EXIT_ERROR, {
      ...errorDiagnostic("Binary resource authentication failed.", { operation: op }),
      ...details,
    });
  }
  if (status === 403) {
    return new ContractError(op, "PERMISSION_DENIED", "Binary resource access was denied.", CONTRACT_EXIT_ERROR, {
      ...errorDiagnostic("Binary resource access was denied.", { operation: op }),
      ...details,
    });
  }
  if (status === 404) {
    return new ContractError(op, "RESOURCE_NOT_FOUND", "Binary resource was not found.", CONTRACT_EXIT_ERROR, {
      ...errorDiagnostic("Binary resource was not found.", { operation: op }),
      ...details,
    });
  }
  if (status === 429) {
    return new ContractError(op, "RATE_LIMITED", "Binary resource request was rate limited.", CONTRACT_EXIT_ERROR, {
      ...errorDiagnostic("Binary resource request was rate limited.", { operation: op }),
      ...{
        ...details,
        retryable: true,
      },
    });
  }
  if (status >= 500) {
    return new ContractError(
      op,
      "SERVER_UNAVAILABLE",
      "Binary resource provider is unavailable.",
      CONTRACT_EXIT_ERROR,
      {
        ...errorDiagnostic("Binary resource provider is unavailable.", { operation: op }),
        ...{
          ...details,
          retryable: true,
        },
      },
    );
  }
  return new ContractError(op, "COMMAND_FAILED", "Binary resource request failed.", CONTRACT_EXIT_ERROR, {
    ...errorDiagnostic("Binary resource request failed.", { operation: op }),
    ...details,
  });
}

export function renderContractError(error: ContractError, asJson: boolean | undefined): void {
  if (getContext({ localOnly: true })?.suppressCliOutput === true) return;
  const envelope = error.envelope();
  if (asJson) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.error(envelope.error.message);
  if (typeof envelope.error.cause === "string" && envelope.error.cause !== envelope.error.message) {
    console.error(`Cause: ${envelope.error.cause}`);
  }
  if (envelope.error.context) {
    for (const [field, value] of Object.entries(projectDiagnosticContext(envelope.error.context))) {
      console.error(`${field}: ${value}`);
    }
  }
  const issues = envelope.error.issues;
  if (!Array.isArray(issues) || issues.length === 0) return;
  if (typeof envelope.error.status === "number") {
    console.error(`status: ${envelope.error.status}`);
  }
  for (const issue of issues) {
    if (!issue || typeof issue !== "object") continue;
    const record = issue as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : "";
    const path = Array.isArray(record.path) ? record.path.map(String).filter(Boolean).join(".") : "";
    const line = path && message ? `${path}: ${message}` : message || path;
    if (line && line !== envelope.error.message) console.error(line);
  }
}

/**
 * Public COMMAND_FAILED copy: keep the sanitized expected/daemon cause.
 * The generic headline is used only when the cause is empty or unsafe.
 */
export function publicContractMessage(code: string, message: string): string {
  if (code !== "COMMAND_FAILED") return message;
  return sanitizePublicContractMessage(message) ?? GENERIC_COMMAND_FAILED_MESSAGE;
}

export function sanitizePublicContractMessage(message: string | undefined): string | undefined {
  if (typeof message !== "string") return undefined;
  const cleaned = stripVTControlCharacters(message)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!cleaned) return undefined;
  const redacted = redactDiagnosticText(cleaned);
  return redacted.length > MAX_PUBLIC_CONTRACT_MESSAGE_LENGTH
    ? `${redacted.slice(0, MAX_PUBLIC_CONTRACT_MESSAGE_LENGTH)} [truncated]`
    : redacted;
}

export interface ContractFailOptions {
  diagnostic: ErrorDiagnostic;
  asJson?: boolean;
  exitCode?: number;
  details?: ContractErrorDetails;
}

/**
 * Fail a command under the Manual v2 contract.
 * Rendering happens here exactly once; the active transport catches the
 * structured error and owns process exit / protocol status / audit flushing.
 */
export function contractFail(op: string, code: string, message: string, options: ContractFailOptions): never {
  const exitCode = options.exitCode ?? CONTRACT_EXIT_ERROR;
  const error = new ContractError(op, code, message, exitCode, { ...options.diagnostic, ...options.details });
  renderContractError(error, options.asJson);
  throw error;
}

/**
 * Write brake (freio): emit the dry-run plan and exit 3 BEFORE any write/DB
 * mutation. The planned input is shown so the agent can inspect exactly what
 * `--execute` would do.
 */
export function contractDryRun(op: string, plan: Record<string, unknown>, options: { asJson?: boolean } = {}): never {
  const error = new ContractError(
    op,
    "WRITE_REQUIRES_EXECUTE",
    `Dry-run: nothing was written. Re-run with --execute to perform the write.`,
    CONTRACT_EXIT_POLICY,
    {
      ...errorDiagnostic(`Dry-run: nothing was written. Re-run with --execute to perform the write.`, {
        operation: op,
      }),
      ...{
        suggestedAction: `Re-run '${op}' adding --execute to perform the write`,
        dryRun: true,
        plan,
      },
    },
  );
  if (getContext({ localOnly: true })?.suppressCliOutput !== true) {
    if (options.asJson) {
      console.log(JSON.stringify(error.envelope(), null, 2));
    } else {
      console.log(`[dry-run] ${op}: nothing was written.`);
      console.log(`Planned input:`);
      console.log(JSON.stringify(error.details.plan, null, 2));
      console.log(`Re-run with --execute to perform the write.`);
    }
  }
  throw error;
}

/**
 * Commander exits that are NOT failures: help/version rendering and async
 * sub-executable termination. They keep commander's own exit code.
 */
const COMMANDER_PASSTHROUGH_CODES = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.version",
  "commander.executeSubCommandAsync",
]);

/**
 * Usage errors (7.x taxonomy, exit 2) raised by the commander PARSER — unknown
 * flag, missing required argument, missing option value — never reach the
 * command body, so `contractFail` alone cannot see them: they used to escape the
 * contract as plain stderr text with exit 1. This installs the same envelope +
 * exit 2 at the parser level.
 *
 * SCOPE: the commander program is shared by every CLI domain, so the hook is
 * attached ONLY to the named `domain` node and its descendants. Sibling groups
 * keep commander's default behavior until they are migrated.
 */
export function installUsageContract(program: CommanderCommand, domain: string): void {
  const domainRoot = program.commands.find((command) => command.name() === domain);
  if (!domainRoot) return;
  for (const command of commandTree(domainRoot)) {
    // Commander prints the plain-text error before exiting; the contract emits
    // the envelope instead, so its writer is silenced on migrated nodes only.
    command.configureOutput({ outputError: () => {} });
    command.exitOverride((error) => failUsage(command, error));
  }
}

/** Install the same usage taxonomy for errors raised by the CLI root parser. */
export function installRootUsageContract(program: CommanderCommand): void {
  program.configureOutput({ outputError: () => {} });
  program.exitOverride((error) => failUsage(program, error));
}

function commandTree(root: CommanderCommand): CommanderCommand[] {
  const nodes: CommanderCommand[] = [root];
  for (const child of root.commands) nodes.push(...commandTree(child));
  return nodes;
}

function failUsage(command: CommanderCommand, error: CommanderError): never {
  if (COMMANDER_PASSTHROUGH_CODES.has(error.code)) process.exit(error.exitCode);
  const commandPath = opPath(command);
  const op = commandPath || "cli";
  const usage = `ravi ${commandPath ? `${commandPath} ` : ""}${command.usage()}`.trim();
  const acceptedFlags = collectAcceptedFlags(command);
  const acceptedPositionals = collectAcceptedPositionals(command);
  const asJson = wantsJson(command);
  const safeMessage = sanitizeUsageErrorMessage(error.message);
  // Text mode teaches the correct syntax inline; --json keeps the message on a
  // single line because `usage`/`acceptedFlags` are already structured fields.
  const textMessage = [
    safeMessage,
    `usage: ${usage}`,
    acceptedFlags.length > 0 ? `accepted flags: ${acceptedFlags.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  contractFail(op, "USAGE_ERROR", asJson ? safeMessage : textMessage, {
    ...{
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
      details: {
        suggestedAction: `Fix the invocation and re-run: ${usage}`,
        usage,
        acceptedFlags,
        acceptedPositionals,
      },
    },
    diagnostic: errorDiagnostic(error, { operation: op }),
  });
}

/** Commander may echo an unknown option's inline value verbatim. */
function sanitizeUsageErrorMessage(message: string): string {
  return message
    .replace(/(['"])(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*)=([\s\S]*?)\1/g, "$1$2=[REDACTED]$1")
    .replace(/(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*)=([^\s'"]+)/g, "$1=[REDACTED]");
}

/** Operation path without the binary name, e.g. `crm opportunity show`. */
function opPath(command: CommanderCommand): string {
  const segments: string[] = [];
  for (let node: CommanderCommand | null = command; node?.parent; node = node.parent) {
    segments.unshift(node.name());
  }
  return segments.join(" ");
}

/** Flags the op really accepts, including the ones inherited from ancestors. */
function collectAcceptedFlags(command: CommanderCommand): string[] {
  const flags: string[] = [];
  for (let node: CommanderCommand | null = command; node?.parent; node = node.parent) {
    for (const option of node.options) {
      const flag = option.long ?? option.short;
      if (flag && !flags.includes(flag)) flags.push(flag);
    }
  }
  return flags;
}

function collectAcceptedPositionals(command: CommanderCommand): string[] {
  return command.registeredArguments.map((argument) => {
    const name = `${argument.name()}${argument.variadic ? "..." : ""}`;
    return argument.required ? `<${name}>` : `[${name}]`;
  });
}

function wantsJson(command: CommanderCommand): boolean {
  const options = command.optsWithGlobals() as Record<string, unknown>;
  if (options.json === true) return true;
  // The failing node may not declare --json itself (e.g. an unknown subcommand
  // under the domain root), so fall back to the operands commander already
  // classified.
  if (command.args.includes("--json")) return true;
  return command.parent === null && process.argv.slice(2).includes("--json");
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
    const requested = new Set(keys);
    for (const key of Object.keys(record)) {
      if (requested.has(key)) {
        picked[key] = record[key];
        continue;
      }

      // Keep the complete row available to @Returns validation while exposing
      // only requested fields through JSON/Object.keys. The gateway validates
      // handlers before serializing their original return value.
      Object.defineProperty(picked, key, {
        value: record[key],
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    return picked as T;
  });
}

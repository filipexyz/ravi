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
 *  - Write brake (7.8): mutating ops are dry-run by default; `--execute` performs
 *    the real write (model: `ravi sessions prune`).
 *  - Compact mode (7.9): listings accept `--fields a,b,c`.
 *
 * Behavior in tool/test context (`hasContext()` true, e.g. daemon or bun tests):
 * instead of printing + exiting, a `ContractError` is thrown carrying the same
 * envelope and exit code, so callers can assert without killing the process.
 */
import type { Command as CommanderCommand, CommanderError } from "commander";
import { fail, hasContext } from "./context.js";

export const CONTRACT_EXIT_ERROR = 1;
export const CONTRACT_EXIT_USAGE = 2;
export const CONTRACT_EXIT_POLICY = 3;

export interface ContractErrorDetails {
  retryable?: boolean;
  suggestedAction?: string;
  suggestions?: string[];
  acceptedFlags?: string[];
  [key: string]: unknown;
}

export interface ContractErrorEnvelope {
  success: false;
  op: string;
  error: { code: string; message: string; retryable: boolean } & ContractErrorDetails;
}

export class ContractError extends Error {
  readonly op: string;
  readonly code: string;
  readonly exitCode: number;
  readonly details: ContractErrorDetails;

  constructor(op: string, code: string, message: string, exitCode: number, details: ContractErrorDetails = {}) {
    super(message);
    this.name = "ContractError";
    this.op = op;
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }

  envelope(): ContractErrorEnvelope {
    const { retryable, ...rest } = this.details;
    return {
      success: false,
      op: this.op,
      error: { code: this.code, message: this.message, retryable: retryable ?? false, ...rest },
    };
  }
}

export interface ContractFailOptions {
  asJson?: boolean;
  exitCode?: number;
  details?: ContractErrorDetails;
}

/**
 * Fail a command under the Manual v2 contract.
 * The legacy text path (non-JSON, exit 1) still delegates to `fail()` so
 * existing behavior and test mocks keep working unchanged.
 */
export function contractFail(op: string, code: string, message: string, options: ContractFailOptions = {}): never {
  const exitCode = options.exitCode ?? CONTRACT_EXIT_ERROR;
  if (!options.asJson && exitCode === CONTRACT_EXIT_ERROR) {
    fail(message);
  }
  const error = new ContractError(op, code, message, exitCode, options.details ?? {});
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
export function contractDryRun(op: string, plan: Record<string, unknown>, options: { asJson?: boolean } = {}): never {
  const error = new ContractError(
    op,
    "WRITE_REQUIRES_EXECUTE",
    `Dry-run: nothing was written. Re-run with --execute to perform the write.`,
    CONTRACT_EXIT_POLICY,
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
  process.exit(CONTRACT_EXIT_POLICY);
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

function commandTree(root: CommanderCommand): CommanderCommand[] {
  const nodes: CommanderCommand[] = [root];
  for (const child of root.commands) nodes.push(...commandTree(child));
  return nodes;
}

function failUsage(command: CommanderCommand, error: CommanderError): never {
  if (COMMANDER_PASSTHROUGH_CODES.has(error.code)) process.exit(error.exitCode);
  const op = opPath(command);
  const usage = `ravi ${op} ${command.usage()}`.trim();
  const acceptedFlags = collectAcceptedFlags(command);
  const acceptedPositionals = collectAcceptedPositionals(command);
  const asJson = wantsJson(command);
  // Text mode teaches the correct syntax inline; --json keeps the message on a
  // single line because `usage`/`acceptedFlags` are already structured fields.
  const textMessage = [
    error.message,
    `usage: ${usage}`,
    acceptedFlags.length > 0 ? `accepted flags: ${acceptedFlags.join(", ")}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  contractFail(op, "USAGE_ERROR", asJson ? error.message : textMessage, {
    asJson,
    exitCode: CONTRACT_EXIT_USAGE,
    details: {
      suggestedAction: `Fix the invocation and re-run: ${usage}`,
      usage,
      acceptedFlags,
      acceptedPositionals,
    },
  });
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
  return command.args.includes("--json");
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

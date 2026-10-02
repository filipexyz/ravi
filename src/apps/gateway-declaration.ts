/**
 * Manifest `gateway` declaration for the Pages app gateway
 * (`console/pages/app-gateway/relay` in the Console specs).
 *
 * `"mutating": false` alone does not make an operation safe for argv chosen by
 * a remote Pages viewer: args are spliced verbatim into the operation command.
 * The declaration is the app author's statement of exactly which long options,
 * flags, and how many positionals a viewer may pass.
 */

import type { RaviAppOperationGatewayArgsDeclaration, RaviAppOperationGatewayDeclaration } from "./types.js";

export const GATEWAY_ARG_NAME_PATTERN = /^--[a-z0-9][a-z0-9-]*$/;
export const GATEWAY_MAX_DECLARED_OPTIONS = 16;
export const GATEWAY_MAX_DECLARED_FLAGS = 16;
export const GATEWAY_MAX_POSITIONAL = 8;

const FORBIDDEN_ARG_NAMES = new Set(["--execute", "--"]);

export interface NormalizedGatewayArgs {
  none: boolean;
  options: ReadonlySet<string>;
  flags: ReadonlySet<string>;
  positional: number;
}

export type GatewayArgsCheck = { ok: true } | { ok: false; index: number; reason: string };

/**
 * Validate a manifest `gateway` value. Pushes one error per problem; an absent
 * declaration is valid (the operation is simply never exposed).
 */
export function validateGatewayDeclaration(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object when present.`);
    return;
  }
  const extra = Object.keys(value).filter((key) => key !== "args");
  if (extra.length > 0) errors.push(`${path} only accepts "args" (found: ${extra.join(", ")}).`);
  const args = value.args;
  if (args === "none") return;
  if (!isPlainObject(args)) {
    errors.push(`${path}.args must be "none" or an object with options, flags, and positional.`);
    return;
  }
  const extraArgs = Object.keys(args).filter((key) => !["options", "flags", "positional"].includes(key));
  if (extraArgs.length > 0) {
    errors.push(`${path}.args only accepts options, flags, and positional (found: ${extraArgs.join(", ")}).`);
  }
  const options = validateNameList(args.options, `${path}.args.options`, GATEWAY_MAX_DECLARED_OPTIONS, errors);
  const flags = validateNameList(args.flags, `${path}.args.flags`, GATEWAY_MAX_DECLARED_FLAGS, errors);
  const overlap = options.filter((name) => flags.includes(name));
  if (overlap.length > 0) {
    errors.push(`${path}.args.options and ${path}.args.flags must be disjoint (both list: ${overlap.join(", ")}).`);
  }
  if (args.positional !== undefined) {
    const positional = args.positional;
    if (
      typeof positional !== "number" ||
      !Number.isInteger(positional) ||
      positional < 0 ||
      positional > GATEWAY_MAX_POSITIONAL
    ) {
      errors.push(`${path}.args.positional must be an integer from 0 to ${GATEWAY_MAX_POSITIONAL}.`);
    }
  }
}

/**
 * Normalize a declaration that already passed manifest validation. Returns
 * null for an absent or invalid declaration so callers fail closed.
 */
export function normalizeGatewayDeclaration(value: unknown): NormalizedGatewayArgs | null {
  if (value === undefined) return null;
  const errors: string[] = [];
  validateGatewayDeclaration(value, "gateway", errors);
  if (errors.length > 0) return null;
  const declaration = value as RaviAppOperationGatewayDeclaration;
  if (declaration.args === "none") {
    return { none: true, options: new Set(), flags: new Set(), positional: 0 };
  }
  const args = declaration.args as RaviAppOperationGatewayArgsDeclaration;
  return {
    none: false,
    options: new Set(args.options ?? []),
    flags: new Set(args.flags ?? []),
    positional: args.positional ?? 0,
  };
}

/**
 * Check viewer argv left to right against a normalized declaration. Accepted
 * args are passed unchanged and in order; any refusal means nothing runs.
 */
export function checkGatewayArgs(declaration: NormalizedGatewayArgs, args: readonly string[]): GatewayArgsCheck {
  if (declaration.none) {
    return args.length === 0 ? { ok: true } : { ok: false, index: 0, reason: "operation accepts no args" };
  }
  const seen = new Set<string>();
  let positional = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (declaration.options.has(arg)) {
      if (seen.has(arg)) return { ok: false, index, reason: "repeated option" };
      seen.add(arg);
      const value = args[index + 1];
      if (value === undefined) return { ok: false, index, reason: "option is missing its value" };
      if (value.startsWith("-")) return { ok: false, index: index + 1, reason: "option value starts with -" };
      index++;
      continue;
    }
    if (declaration.flags.has(arg)) {
      if (seen.has(arg)) return { ok: false, index, reason: "repeated flag" };
      seen.add(arg);
      continue;
    }
    if (arg.startsWith("-")) return { ok: false, index, reason: "undeclared option" };
    positional++;
    if (positional > declaration.positional) return { ok: false, index, reason: "too many positionals" };
  }
  return { ok: true };
}

function validateNameList(value: unknown, path: string, max: number, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    errors.push(`${path} must be an array of long option names when present.`);
    return [];
  }
  const names = value as string[];
  if (names.length > max) errors.push(`${path} lists at most ${max} names.`);
  const seen = new Set<string>();
  for (const name of names) {
    if (FORBIDDEN_ARG_NAMES.has(name)) {
      errors.push(`${path} must never declare ${name}.`);
    } else if (!GATEWAY_ARG_NAME_PATTERN.test(name)) {
      errors.push(`${path} entry "${name}" must match ${GATEWAY_ARG_NAME_PATTERN.source}.`);
    }
    if (seen.has(name)) errors.push(`${path} lists ${name} more than once.`);
    seen.add(name);
  }
  return names;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

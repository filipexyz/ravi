#!/usr/bin/env bun
/** Static, dependency-free-at-runtime catch inventory and monotonic masking-debt gate. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

export const BASELINE_COMMIT = "94682e274af4867dc240b81fc84b7ce76c97efa5";
export const BASELINE_PATH = "scripts/error-cause-baseline.json";
export const FROZEN_PATH = "scripts/error-cause-baseline.frozen.json";
export const INVENTORY_PATH = "design/error-cause-inventory.md";
export type Violation =
  | "catch-without-binding"
  | "rejection-without-binding"
  | "unused-binding-at-surface"
  | "cause-not-forwarded-at-surface"
  | "surface-bypasses-constructor";
export interface CatchSite {
  id: string;
  file: string;
  line: number;
  kind: "catch" | "rejection";
  scope: string;
  boundary: string;
  surface: boolean;
  binding: string[];
  bindingUsed: boolean;
  annotation?: string;
  violation?: Violation;
  state: "no-cause" | "fixed" | "triaged-follow-up";
}
export interface BaselineEntry {
  id: string;
  file: string;
  boundary: string;
  rule: Violation;
  count: number;
}
export interface Baseline {
  version: 1;
  baselineCommit: string;
  entries: BaselineEntry[];
  totals: { violations: number; byDirectory: Record<string, number> };
}
export interface SourceInput {
  file: string;
  text: string;
}
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const SURFACE_CALLS = new Set([
  "contractFail",
  "fail",
  "errorResponse",
  "internalError",
  "permissionDenied",
  "unauthorized",
  "unexpectedErrorToContractError",
  "mapExecutionErrorToContractError",
  "contractErrorResponse",
  "renderContractError",
  "userFailure",
  "createUserFailure",
  "createSurfaceFailure",
  "surfaceFailure",
  "reject",
]);
const SURFACE_CONSTRUCTORS = new Set(["Error", "ContractError", "UserFailure", "SurfaceFailure", "Response"]);
const DIAGNOSTIC_CONSTRUCTORS = new Set([
  "contractFail",
  "ContractError",
  "userFailure",
  "createUserFailure",
  "createSurfaceFailure",
  "surfaceFailure",
]);

function sourceFile(file: string): boolean {
  return (
    file.startsWith("src/") &&
    /\.[cm]?tsx?$/.test(file) &&
    !/\.d\.ts$/.test(file) &&
    !/(?:^|\/)(?:test|tests|__tests__|__fixtures__|fixtures)(?:\/|$)/.test(file) &&
    !/\.(?:test|spec)\.[cm]?tsx?$/.test(file)
  );
}
function nameOf(node: ts.Node, sf: ts.SourceFile): string {
  const named = node as ts.Node & { name?: ts.Node };
  return named.name ? named.name.getText(sf) : "";
}
function scopeOf(node: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  for (let parent = node.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) {
      let name = nameOf(parent, sf);
      if (!name && (ts.isVariableDeclaration(parent.parent) || ts.isPropertyAssignment(parent.parent)))
        name = nameOf(parent.parent, sf);
      if (name) parts.unshift(name);
    }
  }
  return parts.join(".") || "<module>";
}
function bindingNames(node?: ts.BindingName): string[] {
  if (!node) return [];
  if (ts.isIdentifier(node)) return [node.text];
  return node.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}
function usesBinding(body: ts.Node, names: string[]): boolean {
  let used = false;
  const declaredNames = (node: ts.Node): string[] => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) return bindingNames(node.name);
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name ? [node.name.text] : [];
    return [];
  };
  const visit = (node: ts.Node, visible: readonly string[]): void => {
    if (used || visible.length === 0) return;
    let active = visible;
    if (node !== body && (ts.isFunctionLike(node) || ts.isBlock(node))) {
      const declarations: string[] = [];
      if (ts.isFunctionLike(node))
        declarations.push(...node.parameters.flatMap((parameter) => bindingNames(parameter.name)));
      if (ts.isBlock(node)) {
        for (const statement of node.statements) {
          if (ts.isVariableStatement(statement))
            declarations.push(
              ...statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name)),
            );
          else declarations.push(...declaredNames(statement));
        }
      }
      active = visible.filter((name) => !declarations.includes(name));
    }
    if (ts.isIdentifier(node) && active.includes(node.text)) {
      const parent = node.parent;
      if (
        !(ts.isPropertyAccessExpression(parent) && parent.name === node) &&
        !(ts.isPropertyAssignment(parent) && parent.name === node) &&
        !(ts.isVariableDeclaration(parent) && parent.name === node) &&
        !(ts.isParameter(parent) && parent.name === node) &&
        !(ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
      )
        used = true;
    }
    ts.forEachChild(node, (child) => visit(child, active));
  };
  visit(body, names);
  return used;
}
function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression))
    return expression.argumentExpression.text;
  return undefined;
}
function producesSurface(body: ts.Node): boolean {
  let surface = false;
  const visit = (node: ts.Node): void => {
    if (surface) return;
    if (ts.isThrowStatement(node)) surface = true;
    if (ts.isNewExpression(node) && SURFACE_CONSTRUCTORS.has(callName(node.expression) ?? "")) surface = true;
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression) ?? "";
      if (SURFACE_CALLS.has(name) || name === "error") surface = true;
      if (
        /^(?:send|reply|respond|publish|emit)/i.test(name) &&
        node.arguments.some((argument) => /\b(?:error|failed|failure|safe_error)\b/i.test(argument.getText()))
      )
        surface = true;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = property.name.getText().replace(/["']/g, "");
          if (
            key === "error" ||
            key === "safe_error" ||
            (key === "success" && property.initializer.kind === ts.SyntaxKind.FalseKeyword)
          )
            surface = true;
        }
      }
    }
    // Nested handlers have their own entry; their failures are not this handler's surface.
    if (node !== body && (ts.isFunctionLike(node) || ts.isCatchClause(node))) return;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return surface;
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) return node.expression.text;
  return undefined;
}

/** Local value provenance, not merely a reference anywhere in the handler.
 * Diagnostic factories consume their first argument; logging and condition tests
 * do not turn an unrelated literal into the original cause. Interprocedural
 * semantics remain the runtime corpus's responsibility.
 */
function surfaceDiagnosticIssues(body: ts.Node, names: string[]): { bypass: boolean; dropped: boolean } {
  const locals = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (node !== body && (ts.isFunctionLike(node) || ts.isCatchClause(node))) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      locals.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(body);

  const valueUsesCause = (node: ts.Node | undefined, seen = new Set<string>()): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node)) {
      if (names.includes(node.text)) return true;
      if (seen.has(node.text)) return false;
      return valueUsesCause(locals.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name === "errorDiagnostic") return valueUsesCause(node.arguments[0], seen);
      if (name === "log" || name === "warn" || name === "error" || name === "Boolean") return false;
      return (
        (ts.isPropertyAccessExpression(node.expression) && valueUsesCause(node.expression.expression, seen)) ||
        node.arguments.some((argument) => valueUsesCause(argument, seen))
      );
    }
    if (ts.isPropertyAccessExpression(node)) return valueUsesCause(node.expression, seen);
    if (ts.isElementAccessExpression(node)) return valueUsesCause(node.expression, seen);
    if (ts.isConditionalExpression(node))
      return valueUsesCause(node.whenTrue, seen) || valueUsesCause(node.whenFalse, seen);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken)
      return valueUsesCause(node.right, seen);
    if (ts.isFunctionLike(node)) return false;
    if (ts.isObjectLiteralExpression(node))
      return node.properties.some((property) =>
        ts.isPropertyAssignment(property)
          ? valueUsesCause(property.initializer, seen)
          : ts.isShorthandPropertyAssignment(property)
            ? valueUsesCause(property.name, seen)
            : ts.isSpreadAssignment(property) && valueUsesCause(property.expression, seen),
      );
    let used = false;
    ts.forEachChild(node, (child) => {
      if (valueUsesCause(child, seen)) used = true;
    });
    return used;
  };

  const diagnosticProperty = (
    node: ts.Expression | undefined,
    name: string,
    seen = new Set<string>(),
  ): ts.Expression | undefined => {
    if (!node) return undefined;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return undefined;
      return diagnosticProperty(locals.get(node.text), name, new Set([...seen, node.text]));
    }
    if (!ts.isObjectLiteralExpression(node)) return undefined;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
    }
    return undefined;
  };
  const rawFailureValue = (node: ts.Node | undefined, seen = new Set<string>()): boolean => {
    if (!node) return false;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      return rawFailureValue(locals.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const properties = node.properties.filter(ts.isPropertyAssignment);
      const keys = node.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          ? [propertyName(property.name)]
          : [],
      );
      return (
        keys.includes("error") ||
        keys.includes("safe_error") ||
        (keys.includes("code") && keys.includes("message")) ||
        properties.some(
          (property) =>
            ["success", "ok"].includes(propertyName(property.name) ?? "") &&
            property.initializer.kind === ts.SyntaxKind.FalseKeyword,
        )
      );
    }
    if (
      (ts.isCallExpression(node) && ["json", "stringify"].includes(callName(node.expression) ?? "")) ||
      (ts.isNewExpression(node) && callName(node.expression) === "Response")
    )
      return node.arguments?.some((argument) => rawFailureValue(argument, seen)) ?? false;
    if (ts.isConditionalExpression(node))
      return rawFailureValue(node.whenTrue, seen) || rawFailureValue(node.whenFalse, seen);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))
      return rawFailureValue(node.expression, seen);
    return false;
  };
  let bypass = !ts.isBlock(body) && rawFailureValue(body);
  let dropped = false;
  const visit = (node: ts.Node): void => {
    if (node !== body && (ts.isFunctionLike(node) || ts.isCatchClause(node))) return;
    if ((ts.isReturnStatement(node) || ts.isThrowStatement(node)) && rawFailureValue(node.expression)) bypass = true;
    if (ts.isObjectLiteralExpression(node)) {
      const failureShape = rawFailureValue(node);
      // An object used solely as logging metadata is not a manufactured response.
      let ancestor: ts.Node = node;
      while (ancestor.parent && ancestor !== body) {
        if (
          ts.isNewExpression(ancestor.parent) &&
          DIAGNOSTIC_CONSTRUCTORS.has(callName(ancestor.parent.expression) ?? "")
        )
          break;
        if (ts.isCallExpression(ancestor.parent)) {
          const name = callName(ancestor.parent.expression) ?? "";
          if (DIAGNOSTIC_CONSTRUCTORS.has(name)) break;
          if (["log", "warn", "error", "debug", "info", "errorDiagnostic"].includes(name)) break;
          if (SURFACE_CALLS.has(name) || /^(?:send|reply|respond|publish|emit|json)/i.test(name)) {
            if (failureShape) bypass = true;
            break;
          }
        }
        if (ts.isReturnStatement(ancestor.parent) || ts.isThrowStatement(ancestor.parent)) {
          if (failureShape) bypass = true;
          break;
        }
        ancestor = ancestor.parent;
      }
    }
    if (ts.isCallExpression(node) && SURFACE_CALLS.has(callName(node.expression) ?? "")) {
      const name = callName(node.expression);
      const diagnostic =
        name === "contractFail"
          ? diagnosticProperty(node.arguments[3], "diagnostic")
          : name === "unexpectedErrorToContractError" || name === "mapExecutionErrorToContractError"
            ? node.arguments[1]
            : undefined;
      const forwarded =
        name === "contractFail" ||
        name === "unexpectedErrorToContractError" ||
        name === "mapExecutionErrorToContractError"
          ? valueUsesCause(diagnostic)
          : node.arguments.some((argument) => valueUsesCause(argument));
      if (!forwarded) dropped = true;
    }
    if (
      ts.isNewExpression(node) &&
      callName(node.expression) === "ContractError" &&
      !valueUsesCause(node.arguments?.[4])
    )
      dropped = true;
    if (ts.isThrowStatement(node) && !valueUsesCause(node.expression)) dropped = true;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { bypass, dropped };
}
export function concreteNoCauseReason(reason: string): boolean {
  const text = reason.trim();
  return (
    text.length >= 16 &&
    text.split(/\s+/).length >= 3 &&
    !/^(?:todo|fixme|ignore[ds]?|expected|intentional|legacy|no cause|not needed|n\/a|cleanup)[.!\s]*$/i.test(text) &&
    !/\b(?:TODO|FIXME)\b/.test(text)
  );
}
function annotationFor(node: ts.Node, body: ts.Node, sf: ts.SourceFile): string | undefined {
  const start = node.getStart(sf);
  const lineStart = sf.text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const previousLineStart = sf.text.lastIndexOf("\n", Math.max(0, lineStart - 2)) + 1;
  const prefix = sf.text.slice(previousLineStart, start);
  const bodyStart = body.getStart(sf) + (ts.isBlock(body) ? 1 : 0);
  const firstStatementStart = ts.isBlock(body) && body.statements[0] ? body.statements[0].getStart(sf) : body.end;
  const bodyPrefix = sf.text.slice(bodyStart, firstStatementStart);
  const reason = [...(prefix + "\n" + bodyPrefix).matchAll(/\/\/\s*no-cause:\s*([^\r\n]+)/g)].at(-1)?.[1]?.trim();
  return reason && concreteNoCauseReason(reason) ? reason : undefined;
}
export function boundaryFor(file: string): string {
  if (/transcrib/.test(file)) return "transcription";
  if (/media-send|commands\/media\./.test(file)) return "media-send";
  if (/channels\/slack|commands\/(?:channels|slack)\./.test(file)) return "channels-slack";
  if (/sdk\/gateway/.test(file)) return "gateway";
  if (/remote-gateway/.test(file)) return "relay";
  if (/permissions|approval|context-hook/.test(file)) return "permissions";
  if (/omni\/.*audio|channels\/.*audio/.test(file)) return "inbound-audio";
  if (/^src\/omni\//.test(file)) return "omni";
  if (/^src\/watch\//.test(file)) return "watch";
  if (/session/.test(file)) return "sessions";
  if (/^src\/runtime\/|^src\/bot\./.test(file)) return "runtime-chat";
  return file.split("/")[1] ?? "src";
}
export function scanSource(file: string, text: string): CatchSite[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: CatchSite[] = [];
  const add = (node: ts.Node, body: ts.Node, kind: CatchSite["kind"], names: string[]): void => {
    const annotation = annotationFor(node, body, sf);
    const surface = producesSurface(body);
    const bindingUsed = usesBinding(body, names);
    const diagnosticIssues = surfaceDiagnosticIssues(body, names);
    const violation: Violation | undefined =
      !annotation && names.length === 0
        ? kind === "catch"
          ? "catch-without-binding"
          : "rejection-without-binding"
        : !annotation && surface && !bindingUsed
          ? "unused-binding-at-surface"
          : diagnosticIssues.bypass
            ? "surface-bypasses-constructor"
            : !annotation && diagnosticIssues.dropped
              ? "cause-not-forwarded-at-surface"
              : undefined;
    const scope = scopeOf(node, sf);
    const normalized = printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/\s+/g, " ").trim();
    const digest = createHash("sha256").update(`${file}\0${kind}\0${scope}\0${normalized}`).digest("hex").slice(0, 24);
    sites.push({
      id: `${file}:${digest}`,
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      scope,
      boundary: boundaryFor(file),
      surface,
      binding: names,
      bindingUsed,
      ...(annotation ? { annotation } : {}),
      ...(violation ? { violation } : {}),
      state: violation ? "triaged-follow-up" : annotation ? "no-cause" : "fixed",
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) add(node, node.block, "catch", bindingNames(node.variableDeclaration?.name));
    if (ts.isCallExpression(node) && callName(node.expression) === "catch") {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        add(callback, callback.body, "rejection", bindingNames(callback.parameters[0]?.name));
      } else {
        // Referenced/dynamic callbacks are enumerated separately; without interprocedural
        // analysis their binding is unknown. Treat them as debt until annotated.
        add(node, callback ?? node, "rejection", []);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}
export function scanSources(sources: SourceInput[]): CatchSite[] {
  return sources
    .filter(({ file }) => sourceFile(file))
    .sort((a, b) => a.file.localeCompare(b.file))
    .flatMap(({ file, text }) => scanSource(file, text));
}
export function scanWorkingTree(root: string): CatchSite[] {
  const sources: SourceInput[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const file = relative(root, full).replaceAll("\\", "/");
        if (sourceFile(file)) sources.push({ file, text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(join(root, "src"));
  return scanSources(sources);
}
function requireCommit(root: string, ref: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    throw new Error(
      `Error cause ratchet cannot resolve Git commit "${ref}" in this clone. ` +
        "The ref may be missing because history is shallow or its tag was not fetched. " +
        "Fetch full history (actions/checkout fetch-depth: 0) and the error-cause-baseline tag " +
        "(git fetch origin refs/tags/error-cause-baseline:refs/tags/error-cause-baseline). " +
        "For pull requests, use pull_request.base.sha, not a previous head from event.before.",
      { cause },
    );
  }
}
export function scanCommit(root: string, commit: string): CatchSite[] {
  commit = requireCommit(root, commit);
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "--", "src"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(sourceFile);
  const blobs = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: files.map((file) => `${commit}:${file}\n`).join(""),
    maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  const sources = files.map((file): SourceInput => {
    const newline = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, newline).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (newline < offset || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Cannot read frozen source: ${file}`);
    }
    offset = newline + 1;
    const text = blobs.subarray(offset, offset + size).toString("utf8");
    offset += size + 1;
    return { file, text };
  });
  return scanSources(sources);
}
export function makeBaseline(sites: CatchSite[], baselineCommit = BASELINE_COMMIT): Baseline {
  const entries = new Map<string, BaselineEntry>();
  for (const site of sites) {
    if (!site.violation) continue;
    const previous = entries.get(site.id);
    if (previous) previous.count++;
    else
      entries.set(site.id, { id: site.id, file: site.file, boundary: site.boundary, rule: site.violation, count: 1 });
  }
  const sorted = [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  const byDirectory: Record<string, number> = {};
  for (const entry of sorted) {
    const dir = dirname(entry.file);
    byDirectory[dir] = (byDirectory[dir] ?? 0) + entry.count;
  }
  return {
    version: 1,
    baselineCommit,
    entries: sorted,
    totals: { violations: sorted.reduce((sum, entry) => sum + entry.count, 0), byDirectory },
  };
}
export function validateAllowlist(
  current: CatchSite[],
  allowed: Baseline,
  frozen: Baseline,
  previous?: Baseline,
): string[] {
  const errors: string[] = [];
  if (allowed.version !== 1 || allowed.baselineCommit !== BASELINE_COMMIT || frozen.baselineCommit !== BASELINE_COMMIT)
    errors.push("Invalid baseline identity/version");
  const actual = makeBaseline(current);
  const allowedMap = new Map(allowed.entries.map((entry) => [entry.id, entry]));
  if (allowedMap.size !== allowed.entries.length) errors.push("Duplicate allowlist entries");
  for (const ceiling of [frozen, ...(previous ? [previous] : [])]) {
    const ceilingMap = new Map(ceiling.entries.map((entry) => [entry.id, entry]));
    for (const entry of allowed.entries) {
      const old = ceilingMap.get(entry.id);
      if (!old) errors.push(`Allowlist addition forbidden: ${entry.id}`);
      else if (!Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > old.count)
        errors.push(`Allowlist count increase/invalid count: ${entry.id}`);
      else if (entry.file !== old.file || entry.rule !== old.rule || entry.boundary !== old.boundary)
        errors.push(`Allowlist metadata changed: ${entry.id}`);
    }
  }
  for (const entry of actual.entries) {
    const permitted = allowedMap.get(entry.id);
    if (!permitted || entry.count > permitted.count)
      errors.push(`Unlisted masking site (${entry.rule}, count=${entry.count}): ${entry.id}`);
  }
  const actualMap = new Map(actual.entries.map((entry) => [entry.id, entry]));
  for (const entry of allowed.entries) {
    if (entry.count !== actualMap.get(entry.id)?.count)
      errors.push(`Stale allowance must be removed/decreased: ${entry.id}`);
  }
  if (JSON.stringify(allowed.totals) !== JSON.stringify(actual.totals))
    errors.push("Allowlist totals do not match current violations");
  return errors;
}
export function requiredSurfaceBoundaries(sites: CatchSite[]): string[] {
  return [...new Set(sites.filter((site) => site.surface).map((site) => site.boundary))].sort();
}
export function checkSurfaceCoverage(sites: CatchSite[], covered: readonly string[]): string[] {
  return requiredSurfaceBoundaries(sites).filter((boundary) => !covered.includes(boundary));
}
export function renderInventory(sites: CatchSite[], frozen: Baseline): string {
  const debt = sites.filter((site) => site.violation).length;
  const annotated = sites.filter((site) => site.annotation).length;
  const surfaceDebt = sites.filter((site) => site.violation && site.surface).length;
  const escaped = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  return `<!-- GENERATED by bun scripts/error-cause-scan.ts --update; do not edit. -->\n# Error cause inventory\n\nTotal enumerated: **${sites.length}** catch/rejection sites. Current syntactic masking debt: **${debt}** (${surfaceDebt} emit a recognized error surface). Frozen debt: **${frozen.totals.violations}**. Closed since baseline: **${frozen.totals.violations - debt}**. Explicit no-cause reasons: **${annotated}**.\n\nBaseline commit: \`${BASELINE_COMMIT}\`. The allowlist can only shrink. \`fixed\` means the site passes the static binding/surface rules, not that end-to-end behavior has been proven. Runtime corpus tests separately prove propagation and redaction. Referenced or dynamic .catch callbacks are enumerated as debt until documented. Static recognition covers configured surface calls, constructors, throws and error-shaped objects; alias/interprocedural behavior requires corpus tests and review.\n\n| Directory | Current masking debt |\n| --- | ---: |\n${Object.entries(
    makeBaseline(sites).totals.byDirectory,
  )
    .map(([directory, count]) => `| ${directory} | ${count} |`)
    .join(
      "\n",
    )}\n\n| Boundary | File | Line | State | Rule / explicit reason | ID |\n| --- | --- | ---: | --- | --- | --- |\n${sites.map((site) => `| ${escaped(site.boundary)} | ${escaped(site.file)} | ${site.line} | ${site.state} | ${escaped(site.annotation ?? site.violation ?? "binding retained / no recognized error surface")} | ${site.id} |`).join("\n")}\n`;
}
function readBaseline(path: string): Baseline {
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}
export function baselineAtRef(root: string, ref: string): Baseline | undefined {
  // Only absence in a valid tree is exempt; malformed JSON/missing refs fail.
  ref = requireCommit(root, ref);
  const entry = execFileSync("git", ["ls-tree", ref, "--", BASELINE_PATH], { cwd: root, encoding: "utf8" }).trim();
  if (!entry) return undefined;
  return JSON.parse(
    execFileSync("git", ["show", `${ref}:${BASELINE_PATH}`], { cwd: root, encoding: "utf8" }),
  ) as Baseline;
}
function previousBaselines(root: string): Baseline[] {
  const base = process.env.GITHUB_BASE_REF;
  const before = process.env.ERROR_CAUSE_BASE_REF;
  const ref = before && !/^0+$/.test(before) ? before : base ? `origin/${base}` : "origin/dev";
  const snapshots: Baseline[] = [];
  const target = baselineAtRef(root, ref);
  if (target) snapshots.push(target);
  // Also ratchet against the preceding head's history. Otherwise the first PR
  // introducing this gate could re-add debt after removing it in an earlier commit.
  const head = process.env.ERROR_CAUSE_HEAD_REF;
  const ancestry = requireCommit(root, head ? `${head}^` : "HEAD");
  const previous = execFileSync("git", ["log", "-1", "--format=%H", ancestry, "--", BASELINE_PATH], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (previous) {
    const historical = baselineAtRef(root, previous);
    if (!historical) throw new Error("Baseline was removed in prior history");
    snapshots.push(historical);
  }
  return snapshots;
}
function main(): void {
  const root = resolve(import.meta.dir, "..");
  const bootstrap = process.argv.includes("--bootstrap");
  const update = process.argv.includes("--update");
  const frozenPath = join(root, FROZEN_PATH);
  const allowedPath = join(root, BASELINE_PATH);
  if (bootstrap) {
    if (existsSync(frozenPath) || existsSync(allowedPath))
      throw new Error("Bootstrap is one-time; existing baselines cannot be replaced");
    const initial = makeBaseline(scanCommit(root, BASELINE_COMMIT));
    writeFileSync(frozenPath, `${JSON.stringify(initial, null, 2)}\n`);
    writeFileSync(allowedPath, `${JSON.stringify(initial, null, 2)}\n`);
  }
  const frozen = readBaseline(frozenPath);
  // Recompute the ceiling from the immutable commit: changing both JSON files
  // together cannot expand the allowance, including the first PR introducing it.
  const original = makeBaseline(scanCommit(root, BASELINE_COMMIT));
  if (JSON.stringify(frozen) !== JSON.stringify(original))
    throw new Error("Frozen baseline differs from its immutable source commit");
  const sites = scanWorkingTree(root);
  let allowed = readBaseline(allowedPath);
  const previous = previousBaselines(root);
  if (update) {
    const reduced = makeBaseline(sites);
    const additions = reduced.entries.filter(
      (entry) => !allowed.entries.some((old) => old.id === entry.id && old.count >= entry.count),
    );
    if (additions.length)
      throw new Error(`Update refuses ${additions.length} new/increased violations; fix or annotate them`);
    const candidateErrors = [
      ...validateAllowlist(sites, reduced, frozen),
      ...previous.flatMap((snapshot) => validateAllowlist(sites, reduced, frozen, snapshot)),
    ];
    if (candidateErrors.length) throw new Error(candidateErrors.join("\n"));
    allowed = reduced;
    writeFileSync(allowedPath, `${JSON.stringify(allowed, null, 2)}\n`);
  }
  const errors = [
    ...new Set([
      ...validateAllowlist(sites, allowed, frozen),
      ...previous.flatMap((snapshot) => validateAllowlist(sites, allowed, frozen, snapshot)),
    ]),
  ];
  const inventory = renderInventory(sites, frozen);
  if (update || bootstrap) writeFileSync(join(root, INVENTORY_PATH), inventory);
  else if (!existsSync(join(root, INVENTORY_PATH)) || readFileSync(join(root, INVENTORY_PATH), "utf8") !== inventory)
    errors.push("Generated inventory is stale; run bun scripts/error-cause-scan.ts --update");
  console.log(
    JSON.stringify(
      {
        total: sites.length,
        masking: makeBaseline(sites).totals.violations,
        frozen: frozen.totals.violations,
        closed: frozen.totals.violations - makeBaseline(sites).totals.violations,
        errors,
      },
      null,
      2,
    ),
  );
  if (errors.length) process.exitCode = 1;
}
if (import.meta.main) main();

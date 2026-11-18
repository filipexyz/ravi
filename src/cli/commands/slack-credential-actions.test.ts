import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { explainCredentialPolicy, isDestructiveAction } from "../../credentials/broker.js";

/**
 * Every Slack action `ravi slack` sends to the credential broker, classified,
 * with the number of call sites that send it.
 *
 * - `read`: the broker asks nobody.
 * - `write`: the broker asks for approval, except on the author's own turn
 *   when the author holds the action (see the broker SPEC).
 * - `destructive`: the broker always asks, even on the author's own turn,
 *   either because the action's verb says so (`*.delete`, ...) or because the
 *   call marks itself `destructive: true`.
 *
 * The calls are read from the TypeScript AST of `slack.ts`, so comments and
 * strings never count. A new call site, a new action or a changed class fails
 * this test until the table says what the action is.
 */
type ActionClass = "read" | "write" | "destructive";

const SLACK_CREDENTIAL_ACTIONS: Record<string, { class: ActionClass; sites: number }> = {
  "auth.test": { class: "read", sites: 1 },
  "blocks.validate": { class: "read", sites: 1 },
  "canvases.sections.lookup": { class: "read", sites: 1 },
  "conversations.history": { class: "read", sites: 2 },
  "conversations.info": { class: "read", sites: 1 },
  "conversations.list": { class: "read", sites: 1 },
  "conversations.members": { class: "read", sites: 1 },

  // Reads that still ask: the topology exposes Ravi's internal state (agent
  // ids, session keys, routes, policy) and lists DMs; files.list enumerates
  // files per channel and per person. See the broker SPEC.
  "files.list": { class: "write", sites: 1 },
  "slack.topology": { class: "write", sites: 1 },

  "canvases.access.set": { class: "write", sites: 1 },
  "canvases.create": { class: "write", sites: 1 },
  // A section delete or a whole-canvas replace is marked destructive by the
  // call (`isSlackCanvasRemovalChange(change)`); other edits are writes.
  "canvases.edit": { class: "write", sites: 1 },
  // messages-send and blocks-send pick one of the two per call.
  "chat.postEphemeral": { class: "write", sites: 2 },
  "chat.postMessage": { class: "write", sites: 4 },
  "chat.unfurl": { class: "write", sites: 1 },
  "chat.update": { class: "write", sites: 1 },
  "conversations.canvases.create": { class: "write", sites: 1 },
  "conversations.create": { class: "write", sites: 1 },
  "conversations.invite": { class: "write", sites: 1 },
  "conversations.rename": { class: "write", sites: 1 },
  "entity.presentDetails": { class: "write", sites: 1 },
  "slack.interactions.respond": { class: "write", sites: 1 },
  "slack.messages.replay": { class: "write", sites: 1 },
  "views.open": { class: "write", sites: 1 },
  "views.push": { class: "write", sites: 1 },
  "views.update": { class: "write", sites: 1 },

  "canvases.access.delete": { class: "destructive", sites: 1 },
  "canvases.delete": { class: "destructive", sites: 1 },
  "slack.canvas.artifact.publish": { class: "destructive", sites: 1 },
  "slack.canvas.channelShowcase": { class: "destructive", sites: 1 },
  "slack.canvas.showcase": { class: "destructive", sites: 1 },
};

/** The only `destructive:` value that is not the literal `true`, by action. */
const CONDITIONAL_DESTRUCTIVE_MARKS: Record<string, string> = {
  "canvases.edit": "isSlackCanvasRemovalChange(change)",
};

/**
 * Credential entry points and the functions allowed to call them without
 * being a classified site: the helpers that forward an action they received.
 */
const ENTRY_POINTS = [
  "createSlackOpsContext",
  "mutationOpsContext",
  "mutationCredentialContext",
  "resolveSlackCredentialContext",
  "resolveSlackCredentialConfigFromEnv",
] as const;
/**
 * Each forwarding call and its arguments, as source text with whitespace
 * collapsed. A forwarder that starts passing anything else (a hard-coded
 * action, a dropped destructive mark) fails the test.
 */
const KNOWN_INTERNAL_CALLS: Record<string, string> = {
  "resolveSlackCredentialContext → resolveSlackCredentialConfigFromEnv":
    'process.env | { action, ...(options.destructive ? { destructive: true } : {}), channel, channels, authority: { kind: "local-operator" }, }',
  "createSlackOpsContext → resolveSlackCredentialContext": "target | action | contract",
  "mutationCredentialContext → resolveSlackCredentialContext":
    "target | input.action | contract | { ...(input.destructive ? { destructive: true } : {}), }",
  "mutationOpsContext → mutationCredentialContext": "input",
};

/** The only declarations of the entry-point names allowed in slack.ts. */
const ENTRY_POINT_DECLARATIONS = [
  "import resolveSlackCredentialConfigFromEnv",
  "function createSlackOpsContext",
  "function resolveSlackCredentialContext",
  "method mutationCredentialContext",
  "method mutationOpsContext",
];

interface BrokerCall {
  action: string;
  line: number;
  /** Source text of the `destructive:` property, when the call sets one. */
  destructive?: string;
}

interface Extraction {
  calls: BrokerCall[];
  internal: string[];
  declarations: string[];
  problems: string[];
}

const fileName = join(import.meta.dir, "slack.ts");
const sourceFile = ts.createSourceFile(fileName, readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true);

function lineOf(node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return callee.name.text;
  }
  return undefined;
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText(sourceFile);
    }
  }
  return "<top level>";
}

/** String literals of `"a"` or `cond ? "a" : "b"`; null for anything else. */
function literalActions(expression: ts.Expression): string[] | null {
  if (ts.isStringLiteral(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    const whenTrue = literalActions(expression.whenTrue);
    const whenFalse = literalActions(expression.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

/** `action: method` → the `const method = ...` of literals in the same function. */
function resolveConstActions(identifier: ts.Identifier): string[] | null {
  let scope: ts.Node | undefined = identifier.parent;
  while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
  if (!scope) return null;
  let found: string[] | null = null;
  let declarations = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      declarations += 1;
      found = literalActions(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return declarations === 1 ? found : null;
}

function topLevelProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === name,
  );
}

function isEntryPointName(name: string): boolean {
  return (ENTRY_POINTS as readonly string[]).includes(name);
}

/**
 * Every identifier spelling an entry point must be a declaration or the
 * callee of a call this extractor reads (`name(...)` or `this.name(...)`).
 * An alias (`const send = createSlackOpsContext`), another receiver
 * (`other.mutationOpsContext(...)`), `.bind`/`.call`, or passing the
 * function as a value would hide a broker call, so each one fails.
 */
function checkIdentifier(identifier: ts.Identifier, result: Extraction): void {
  const parent = identifier.parent;
  const where = `slack.ts:${lineOf(identifier)}`;
  if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === identifier) {
    result.declarations.push(`${ts.isFunctionDeclaration(parent) ? "function" : "method"} ${identifier.text}`);
    return;
  }
  if (ts.isImportSpecifier(parent) && parent.name === identifier) {
    result.declarations.push(`import ${identifier.text}`);
    return;
  }
  if (ts.isCallExpression(parent) && parent.expression === identifier) return;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === identifier &&
    parent.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  ) {
    return;
  }
  result.problems.push(`${where}: ${identifier.text} used as ${ts.SyntaxKind[parent.kind]}, not as a direct call`);
}

function extract(): Extraction {
  const result: Extraction = { calls: [], internal: [], declarations: [], problems: [] };
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && isEntryPointName(node.text)) checkIdentifier(node, result);
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee && isEntryPointName(callee)) record(node, callee, result);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function argumentsText(call: ts.CallExpression): string {
  return call.arguments
    .map((argument) => argument.getText(sourceFile))
    .join(" | ")
    .replace(/\s+/g, " ");
}

function record(call: ts.CallExpression, callee: string, result: Extraction): void {
  const where = `slack.ts:${lineOf(call)}`;
  const internalKey = `${enclosingFunctionName(call)} → ${callee}`;
  const expectedArguments = KNOWN_INTERNAL_CALLS[internalKey];
  if (expectedArguments !== undefined) {
    result.internal.push(internalKey);
    const actual = argumentsText(call);
    if (actual !== expectedArguments) {
      result.problems.push(`${where}: ${internalKey} forwards (${actual}), expected (${expectedArguments})`);
    }
    return;
  }

  if (callee === "createSlackOpsContext") {
    const action = call.arguments[1];
    const actions = action ? literalActions(action) : null;
    if (!actions) return void result.problems.push(`${where}: createSlackOpsContext action is not a string literal`);
    for (const value of actions) result.calls.push({ action: value, line: lineOf(call) });
    return;
  }

  if (callee === "mutationOpsContext" || callee === "mutationCredentialContext") {
    const input = call.arguments[0];
    if (!input || !ts.isObjectLiteralExpression(input)) {
      return void result.problems.push(`${where}: ${callee} input is not an object literal`);
    }
    // A spread could bring in an action or a destructive mark the table
    // never sees; every property must be written in the call.
    if (input.properties.some((property) => ts.isSpreadAssignment(property))) {
      return void result.problems.push(`${where}: ${callee} input spreads another object`);
    }
    const action = topLevelProperty(input, "action");
    if (!action) return void result.problems.push(`${where}: ${callee} has no top-level action`);
    const actions = ts.isIdentifier(action.initializer)
      ? resolveConstActions(action.initializer)
      : literalActions(action.initializer);
    if (!actions) return void result.problems.push(`${where}: ${callee} action is not a string literal`);
    const destructive = topLevelProperty(input, "destructive")?.initializer.getText(sourceFile);
    for (const value of actions) {
      result.calls.push({ action: value, line: lineOf(call), ...(destructive !== undefined ? { destructive } : {}) });
    }
    return;
  }

  // resolveSlackCredentialContext / resolveSlackCredentialConfigFromEnv
  // called from anywhere but the known helpers: an unclassified entry path.
  result.problems.push(`${where}: ${internalKey} is not a known credential path`);
}

function brokerClass(call: BrokerCall): ActionClass {
  if (call.destructive === "true" || isDestructiveAction(call.action)) return "destructive";
  return explainCredentialPolicy({ provider: "slack", connection: "any", action: call.action }).approval.required
    ? "write"
    : "read";
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/**
 * How each entry point is declared: exported or not, and for methods whether
 * they are private. An exported helper or a public mutation method could be
 * called from another file, outside this test's reach.
 */
function entryPointVisibility(): Record<string, string> {
  const visibility: Record<string, string> = {};
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      const name = node.name.getText(sourceFile);
      if (isEntryPointName(name)) {
        const exported =
          hasModifier(node, ts.SyntaxKind.ExportKeyword) || hasModifier(node, ts.SyntaxKind.DefaultKeyword);
        const access = ts.isMethodDeclaration(node)
          ? hasModifier(node, ts.SyntaxKind.PrivateKeyword)
            ? " private"
            : " not-private"
          : "";
        visibility[name] = `${exported ? "exported" : "local"}${access}`;
      }
    }
    // `export { name }` / `export { name as other }` re-exports.
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const local = (element.propertyName ?? element.name).text;
        if (isEntryPointName(local)) visibility[`re-export ${local}`] = "exported";
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return visibility;
}

describe("Slack actions sent to the credential broker", () => {
  const { calls, internal, declarations, problems } = extract();

  it("reaches every credential entry point through a known helper or a classified site", () => {
    expect(problems).toEqual([]);
    expect(internal.sort()).toEqual(Object.keys(KNOWN_INTERNAL_CALLS).sort());
  });

  it("declares each entry point once and uses it only as a direct call", () => {
    expect(declarations.sort()).toEqual([...ENTRY_POINT_DECLARATIONS].sort());
  });

  it("keeps the entry points local to slack.ts: no export, and the mutation methods private", () => {
    expect(entryPointVisibility()).toEqual({
      createSlackOpsContext: "local",
      resolveSlackCredentialContext: "local",
      mutationCredentialContext: "local private",
      mutationOpsContext: "local private",
    });
  });

  it("finds exactly the call sites the table counts", () => {
    const expected = Object.values(SLACK_CREDENTIAL_ACTIONS).reduce((total, entry) => total + entry.sites, 0);
    expect(calls.length).toBe(expected);
  });

  it("classifies every action slack.ts sends, and nothing it does not send", () => {
    const sent = [...new Set(calls.map((call) => call.action))].sort();
    expect(sent).toEqual(Object.keys(SLACK_CREDENTIAL_ACTIONS).sort());
  });

  for (const [action, expected] of Object.entries(SLACK_CREDENTIAL_ACTIONS)) {
    it(`${action} is a ${expected.class} for the broker at ${expected.sites} site(s)`, () => {
      const sites = calls.filter((call) => call.action === action);
      expect(sites.length).toBe(expected.sites);
      for (const call of sites) {
        expect({ line: call.line, class: brokerClass(call) }).toEqual({ line: call.line, class: expected.class });
      }
    });
  }

  it("marks the three whole-canvas publishers destructive with a literal true", () => {
    for (const action of ["slack.canvas.showcase", "slack.canvas.channelShowcase", "slack.canvas.artifact.publish"]) {
      const sites = calls.filter((call) => call.action === action);
      expect(sites.map((call) => call.destructive)).toEqual(["true"]);
      // The verb alone would not ask: only the mark makes these destructive.
      expect(isDestructiveAction(action)).toBe(false);
    }
  });

  it("allows a non-literal destructive mark only where the table expects one", () => {
    const conditional = calls
      .filter((call) => call.destructive !== undefined && call.destructive !== "true")
      .map((call) => [call.action, call.destructive]);
    expect(Object.fromEntries(conditional)).toEqual(CONDITIONAL_DESTRUCTIVE_MARKS);
  });
});

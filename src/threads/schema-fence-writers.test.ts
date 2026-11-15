import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fenceModule = "src/threads/schema-fence.ts";
const dynamic = "__DYNAMIC_SQL_TARGET__";
const compact = (value: string) => value.replace(/\s+/g, " ").trim();

type Finding = { file: string; line: number; reason: string; sql: string };
type SqlExpression = { node: ts.Expression; sql: string; raw: string };

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
    ? unwrap(node.expression)
    : node;
}

function owner(node: ts.Node): string {
  for (let parent: ts.Node | undefined = node; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent.name.text;
    if (ts.isMethodDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  }
  return "<module>";
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function constants(source: ts.SourceFile): Map<string, ts.Expression> {
  const declarations = new Map<string, ts.Expression>();
  const bindings = new Map<string, number>();
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) bindings.set(name.text, (bindings.get(name.text) ?? 0) + 1);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  walk(source, (node) => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name);
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isImportClause(node)) &&
      node.name
    )
      bind(node.name);
    else if (ts.isImportSpecifier(node) || ts.isNamespaceImport(node)) bind(node.name);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      node.parent.flags & ts.NodeFlags.Const &&
      ts.isVariableStatement(node.parent.parent) &&
      ts.isSourceFile(node.parent.parent.parent)
    )
      declarations.set(node.name.text, node.initializer);
  });
  // Resolve only unambiguous module constants. A parameter, local declaration,
  // destructuring binding or another scope with the same spelling invalidates
  // the name globally; uncertain targets must fail closed instead of borrowing
  // a convenient non-thread table from an unrelated scope.
  return new Map([...declarations].filter(([name]) => bindings.get(name) === 1));
}

function stringValue(
  expression: ts.Expression,
  declarations: Map<string, ts.Expression>,
  seen = new Set<string>(),
  resolveConstants = true,
): string {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return (
      node.head.text +
      node.templateSpans
        .map((span) => {
          const value = stringValue(span.expression, declarations, seen, resolveConstants);
          return (
            (value === dynamic && !resolveConstants ? `\${${span.expression.getText()}}` : value) + span.literal.text
          );
        })
        .join("")
    );
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      stringValue(node.left, declarations, seen, resolveConstants) +
      stringValue(node.right, declarations, seen, resolveConstants)
    );
  }
  if (resolveConstants && ts.isIdentifier(node) && !seen.has(node.text)) {
    const initializer = declarations.get(node.text);
    if (initializer) return stringValue(initializer, declarations, new Set([...seen, node.text]), true);
  }
  return dynamic;
}

function expressions(source: ts.SourceFile, declarations: Map<string, ts.Expression>): SqlExpression[] {
  const result: SqlExpression[] = [];
  const visited = new Set<ts.Node>();
  walk(source, (node) => {
    if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node))
      return;
    let expression: ts.Expression = node;
    while (
      expression.parent &&
      (ts.isParenthesizedExpression(expression.parent) ||
        ts.isAsExpression(expression.parent) ||
        (ts.isBinaryExpression(expression.parent) && expression.parent.operatorToken.kind === ts.SyntaxKind.PlusToken))
    ) {
      expression = expression.parent;
    }
    if (visited.has(expression)) return;
    visited.add(expression);
    const sql = stringValue(expression, declarations);
    if (!/\b(?:INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) return;
    result.push({ node: expression, sql, raw: stringValue(expression, declarations, new Set(), false) });
  });
  return result;
}

function protectedTables(): Set<string> {
  const source = parse(fenceModule, readFileSync(join(repository, fenceModule), "utf8"));
  const initializer = constants(source).get("THREAD_FENCED_TABLES");
  if (!initializer || !ts.isArrayLiteralExpression(unwrap(initializer)))
    throw new Error("Thread fence table catalog is not a static array");
  return new Set(
    (unwrap(initializer) as ts.ArrayLiteralExpression).elements.map((node) => {
      if (!ts.isStringLiteral(node)) throw new Error("Thread fence table catalog contains a dynamic target");
      return node.text.toLowerCase();
    }),
  );
}

function mutationTargets(sql: string): string[] {
  const identifier = "(?:\"(?:[^\"]|\"\")+\"|'(?:[^']|'')+'|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[a-zA-Z_][a-zA-Z_0-9]*)";
  const matcher = new RegExp(
    `\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+(${identifier}(?:\\s*\\.\\s*${identifier})?)`,
    "gi",
  );
  const updateTail = new RegExp(
    `^\\s+(?:AS\\s+${identifier}\\s+)?(?:(?:INDEXED\\s+BY\\s+${identifier}|NOT\\s+INDEXED)\\s+)?SET\\b`,
    "i",
  );
  const stripped = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  return [...stripped.matchAll(matcher)]
    .filter((match) => !/^UPDATE\b/i.test(match[0]) || updateTail.test(stripped.slice(match.index! + match[0].length)))
    .map((match) =>
      match[1]!
        .split(".")
        .at(-1)!
        .trim()
        .replace(/^["'`[]|["'`\]]$/g, "")
        .toLowerCase(),
    );
}

function wrapperImports(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const imported = resolve(repository, dirname(source.fileName), statement.moduleSpecifier.text).replace(
      /\.js$/,
      ".ts",
    );
    if (imported !== join(repository, fenceModule)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if ((binding.propertyName ?? binding.name).text === "runThreadMutation") names.add(binding.name.text);
      }
    }
  }
  // Import spelling is insufficient if a local parameter or declaration shadows
  // the binding. Refuse ambiguous aliases instead of certifying the wrong call.
  walk(source, (node) => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      names.delete(node.name.text);
  });
  return names;
}

// The shared initializer also serves non-router databases. This is the only
// adapter exception: its entire guarded branch must keep the reviewed shape.
const markerAdapter = compact(
  "usesThreadSchemaFence(db) ? runThreadMutation(db, sql, ...values) : db.query(sql).run(...values)",
);
function validMarkerAdapter(source: ts.SourceFile): boolean {
  if (source.fileName !== "src/db/schema-owner.ts") return false;
  const adapters: boolean[] = [];
  walk(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "markerWrite" &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      adapters.push(
        owner(node) === "initializeStateSchema" &&
          compact(node.initializer.parameters.map((parameter) => parameter.getText(source)).join(", ")) ===
            "sql: string, ...values: string[]" &&
          compact(node.initializer.body.getText(source)) === markerAdapter,
      );
    }
  });
  return adapters.length === 1 && adapters[0] === true && wrapperImports(source).has("runThreadMutation");
}

function wrapped(node: ts.Expression, source: ts.SourceFile, imports: Set<string>, seen = new Set<string>()): boolean {
  let expression = node;
  while (expression.parent && (ts.isParenthesizedExpression(expression.parent) || ts.isAsExpression(expression.parent)))
    expression = expression.parent;
  const parent = expression.parent;
  if (parent && ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
    if (imports.has(parent.expression.text) && parent.arguments[1] === expression) return true;
    if (
      parent.expression.text === "markerWrite" &&
      parent.arguments[0] === expression &&
      owner(parent) === "initializeStateSchema" &&
      validMarkerAdapter(source)
    )
      return true;
  }
  if (!parent || !ts.isVariableDeclaration(parent) || !ts.isIdentifier(parent.name) || seen.has(parent.name.text))
    return false;
  const name = parent.name.text;
  const references: ts.Identifier[] = [];
  walk(source, (candidate) => {
    if (ts.isIdentifier(candidate) && candidate.text === name && candidate !== parent.name) references.push(candidate);
  });
  return (
    references.length > 0 &&
    references.every((reference) => wrapped(reference, source, imports, new Set([...seen, name])))
  );
}

const dynamicExceptions = [
  {
    file: "src/workflows/workflow-db.ts",
    owner: "runWorkflowUpdate",
    sql: `UPDATE \${table} SET \${assignments.join(", ")} WHERE \${idColumn} = ?`,
    reason: "The helper parameter is a union of workflow_runs/workflow_node_runs, neither thread-owned.",
    evidence: 'table: "workflow_runs" | "workflow_node_runs"',
  },
  {
    file: "src/runtime/observation-plane.ts",
    owner: "migrateObservationCommandAccessGrants",
    sql: `UPDATE \${table} SET permission_grants_json = ? WHERE id = ?`,
    reason: "The local const loop visits observer_rules/observer_bindings only.",
    evidence: 'for (const table of ["observer_rules", "observer_bindings"] as const)',
  },
  {
    file: "src/router/router-db.ts",
    owner: "buildTtlPruneDeleteSql",
    sql: `DELETE FROM \${table} WHERE rowid IN (SELECT rowid FROM \${table} WHERE \${whereSql} LIMIT ?)`,
    reason:
      "The private TTL builder receives only the six table literals from ttlPruneTableSpecs; checked separately below.",
    evidence: "const specs = ttlPruneTableSpecs(now)",
  },
] as const;

function allowedDynamic(source: ts.SourceFile, expression: SqlExpression): boolean {
  return dynamicExceptions.some(
    (exception) =>
      exception.file === source.fileName &&
      exception.owner === owner(expression.node) &&
      compact(exception.sql) === compact(expression.raw) &&
      compact(source.text).includes(compact(exception.evidence)) &&
      exception.reason.length > 20,
  );
}

// These are the existing synchronous transaction owners. The exact SQL and
// containing function are allowlisted, never the entire file or future stores.
const transactionOwners = [
  {
    file: "src/db/write-retry.ts",
    owner: "executeWriteWithStats",
    sql: ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"],
    reason:
      "Owns the existing outer transaction and lock retry; individual thread DML removes its lease before returning.",
  },
  {
    file: fenceModule,
    owner: "mutateWithLease",
    sql: [
      "BEGIN IMMEDIATE",
      "COMMIT",
      "ROLLBACK",
      `SAVEPOINT \${savepoint}`,
      `RELEASE SAVEPOINT \${savepoint}`,
      `ROLLBACK TO SAVEPOINT \${savepoint}; RELEASE SAVEPOINT \${savepoint}`,
    ],
    reason:
      "The narrow fence primitive alone owns its transaction/savepoint; it executes one prepared DML, never a callback.",
  },
] as const;

function transactionControls(sql: string): string[] {
  // Keep trigger BEGIN/CASE/END blocks together; their END is SQL DDL, not a
  // transaction commit. Quoted SQL values and comments remain opaque tokens.
  const tokens =
    sql.match(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|;/g) ??
    [];
  const controls: string[] = [];
  let words: string[] = [];
  let trigger = false;
  let depth = 0;
  for (const token of tokens) {
    if (token.startsWith("--") || token.startsWith("/*")) continue;
    const word = token.toUpperCase();
    words.push(word);
    if (words[0] === "CREATE" && word === "TRIGGER") trigger = true;
    if (trigger && (word === "BEGIN" || word === "CASE")) depth += 1;
    if (trigger && word === "END") depth -= 1;
    if (word !== ";" || (trigger && depth > 0)) continue;
    if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)$/.test(words[0] ?? "")) controls.push(words[0]!);
    words = [];
    trigger = false;
    depth = 0;
  }
  if (/^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)$/.test(words[0] ?? "")) controls.push(words[0]!);
  return controls;
}

function audit(file: string, text: string, tables: Set<string>): Finding[] {
  // Cheap lexical filter before parsing; no filename allowlist for production
  // writers. A future thirteenth store is discovered exactly like today's files.
  if (
    !/\b(?:INSERT|UPDATE|DELETE|REPLACE|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text) &&
    !new RegExp(`\\b(?:${[...tables].join("|")})\\b`, "i").test(text)
  )
    return [];
  const source = parse(file, text);
  const sql = expressions(source, constants(source));
  const imports = wrapperImports(source);
  const hasProtectedDml = sql.some((expression) =>
    mutationTargets(expression.sql).some((target) => tables.has(target)),
  );
  const findings: Finding[] = [];
  const seenTransactionExceptions = new Set<string>();
  const report = (expression: SqlExpression, reason: string) =>
    findings.push({
      file,
      line: source.getLineAndCharacterOfPosition(expression.node.getStart(source)).line + 1,
      reason,
      sql: compact(expression.raw).slice(0, 180),
    });
  for (const expression of sql) {
    const targets = mutationTargets(expression.sql);
    if (targets.some((target) => tables.has(target)) && !wrapped(expression.node, source, imports))
      report(expression, "protected DML does not use runThreadMutation");
    if (targets.includes(dynamic.toLowerCase()) && !allowedDynamic(source, expression))
      report(expression, "dynamic mutation target requires an explicit constrained exception");
    if (
      (hasProtectedDml || transactionOwners.some((entry) => entry.file === file)) &&
      transactionControls(expression.sql).length
    ) {
      const allowed = transactionOwners.some(
        (entry) =>
          entry.file === file &&
          entry.owner === owner(expression.node) &&
          entry.sql.some((statement) => compact(statement) === compact(expression.raw)) &&
          entry.reason.length > 20,
      );
      const exceptionKey = `${owner(expression.node)}:${compact(expression.raw)}`;
      if (!allowed || seenTransactionExceptions.has(exceptionKey))
        report(expression, "raw transaction control outside the reviewed transaction owner");
      else seenTransactionExceptions.add(exceptionKey);
    }
  }
  return findings;
}

function isProductionSource(file: string): boolean {
  // Tests cannot write live state; vendored dependencies and build output are
  // not owned source. All other JS/TS, including scripts, packages and generated
  // source, is discovered regardless of its directory or current writer names.
  return (
    /\.[cm]?[jt]sx?$/.test(file) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
    !/\.d\.[cm]?ts$/.test(file) &&
    !/(?:^|\/)(?:node_modules|vendor|dist|build|coverage|test|tests|__tests__|__fixtures__)(?:\/|$)/.test(file)
  );
}

function productionSources(): string[] {
  // Git supplies repository-wide discovery, including a new untracked writer
  // during local development. No src-only root or fixed writer-file allowlist.
  return [
    ...new Set(
      execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: repository,
        encoding: "utf8",
      }).split("\0"),
    ),
  ].filter((file) => isProductionSource(file) && existsSync(join(repository, file)));
}

describe("thread fence writer coverage", () => {
  const tables = protectedTables();

  it("discovers protected DML across all production source files and rejects unwrapped writers", () => {
    expect(tables.size).toBeGreaterThan(0);
    const findings = productionSources().flatMap((file) =>
      audit(file, readFileSync(join(repository, file), "utf8"), tables),
    );
    expect(findings).toEqual([]);
  });

  it.each([
    "INSERT INTO threads VALUES (?)",
    "UPDATE threads SET title=?",
    "DELETE FROM threads",
    "REPLACE INTO threads VALUES (?)",
  ])("rejects an unwrapped mutation in a new unrelated store: %s", (sql) => {
    expect(
      audit("src/future/new-store.ts", `db.prepare(${JSON.stringify(sql)}).run(value);`, tables).some((entry) =>
        entry.reason.includes("protected DML"),
      ),
    ).toBe(true);
  });

  it.each([
    "UPDATE threads AS t SET title=? WHERE t.id=?",
    'UPDATE main."threads" AS "quoted alias" SET title=?',
    'UPDATE threads AS "quoted""alias" INDEXED BY "index name" SET title=?',
    "UPDATE threads AS 'quoted''alias' NOT INDEXED SET title=?",
    "UPDATE threads AS `quoted``alias` SET title=?",
    "UPDATE threads AS [quoted alias] SET title=?",
  ])("rejects an unwrapped UPDATE with a valid SQLite alias: %s", (sql) => {
    const source = `db.prepare(${JSON.stringify(sql)}).run(value);`;
    expect(
      audit("src/future/new-store.ts", source, tables).some((entry) => entry.reason.includes("protected DML")),
    ).toBe(true);
  });

  it("does not lose a dynamic mutation target when UPDATE supplies a quoted alias", () => {
    const source = `db.exec(\`UPDATE \${table} AS "quoted alias" NOT INDEXED SET title=?\`);`;
    expect(
      audit("src/future/new-store.ts", source, tables).some((entry) =>
        entry.reason.includes("dynamic mutation target"),
      ),
    ).toBe(true);
  });

  it.each([
    `const table="sessions"; function mutate(table: string) { db.exec(\`UPDATE \${table} SET title=?\`); }`,
    `const table="sessions"; function mutate(table: string) { db.exec(\`UPDATE \${table} AS "quoted alias" SET title=?\`); }`,
    `const table="sessions"; function mutate({ table }: Input) { db.exec(\`UPDATE \${table} AS t SET title=?\`); }`,
    `const table="sessions"; function mutate() { let table = target(); db.exec(\`UPDATE \${table} AS t SET title=?\`); }`,
    `function unrelated() { const table="sessions"; } function mutate(table: string) { db.exec(\`UPDATE \${table} AS t SET title=?\`); }`,
  ])("does not resolve a dynamic target through an unrelated or shadowed constant: %s", (text) => {
    expect(
      audit("src/future/new-store.ts", text, tables).some((entry) => entry.reason.includes("dynamic mutation target")),
    ).toBe(true);
  });

  it("resolves an unambiguous module constant and discovers writers outside src", () => {
    expect(
      audit("scripts/tool.ts", `const table="sessions"; db.exec(\`UPDATE \${table} AS t SET title=?\`);`, tables),
    ).toEqual([]);
    for (const file of ["scripts/new-store.ts", "packages/future/store.js", "bin/new-store.mjs"]) {
      expect(isProductionSource(file)).toBe(true);
      expect(audit(file, 'db.exec("UPDATE threads AS t SET title=?");', tables).length).toBeGreaterThan(0);
    }
  });

  it("rejects dynamic/concatenated targets, SQL aliases and an untrusted function with the wrapper's name", () => {
    for (const text of [
      `db.exec(\`UPDATE \${table} SET title=?\`);`,
      'db.exec("UPDATE " + "threads SET title=?");',
      'db.exec("UP" + "DATE threads SET title=?");',
      'const sql = "DELETE FROM threads"; db.query(sql).run();',
      'function runThreadMutation(...args) {} runThreadMutation(db, "DELETE FROM threads");',
      'import { runThreadMutation } from "../threads/schema-fence.js"; function f(runThreadMutation) { runThreadMutation(db, "DELETE FROM threads"); }',
    ]) {
      expect(audit("src/future/new-store.ts", text, tables).length).toBeGreaterThan(0);
    }
  });

  it("rejects an additional COMMIT even inside a legitimate transaction owner's function", () => {
    const text =
      'function executeWriteWithStats() { db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT"); db.exec("COMMIT"); }';
    expect(
      audit("src/db/write-retry.ts", text, tables).some((entry) => entry.reason.includes("transaction control")),
    ).toBe(true);
  });

  it.each(["COMMIT", "END", "BEGIN IMMEDIATE", "ROLLBACK", "SELECT 1; COMMIT"])(
    "rejects raw transaction control next to an otherwise wrapped writer: %s",
    (control) => {
      const text = `import { runThreadMutation } from "../threads/schema-fence.js"; runThreadMutation(db, "DELETE FROM threads"); db.exec(${JSON.stringify(control)});`;
      expect(
        audit("src/future/new-store.ts", text, tables).some((entry) => entry.reason.includes("transaction control")),
      ).toBe(true);
    },
  );

  it("accepts imported wrapper aliases and existing outer transaction ownership", () => {
    const text =
      'import { runThreadMutation as mutate } from "../threads/schema-fence.js"; const sql = "UPDATE threads SET title=?"; db.transaction(() => mutate(db, sql, title)).immediate();';
    expect(audit("src/future/new-store.ts", text, tables)).toEqual([]);
    expect(
      audit(
        "src/db/write-retry.ts",
        'function executeWriteWithStats() { db.exec("BEGIN IMMEDIATE"); db.exec("COMMIT"); }',
        tables,
      ),
    ).toEqual([]);
  });

  it("does not mistake trigger END for COMMIT or exempt a following raw COMMIT", () => {
    expect(
      transactionControls("CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 2 END; END;"),
    ).toEqual([]);
    expect(transactionControls("CREATE TRIGGER t BEFORE INSERT ON x BEGIN SELECT 1; END; COMMIT;")).toEqual(["COMMIT"]);
  });

  it("keeps the TTL exception constrained to its existing six non-thread targets", () => {
    const source = parse("src/router/router-db.ts", readFileSync(join(repository, "src/router/router-db.ts"), "utf8"));
    const targets: string[] = [];
    const calls: Array<{ name: string; owner: string; argument: string | undefined }> = [];
    walk(source, (node) => {
      if (
        owner(node) === "ttlPruneTableSpecs" &&
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === "table"
      ) {
        expect(ts.isStringLiteral(node.initializer)).toBe(true);
        if (ts.isStringLiteral(node.initializer)) targets.push(node.initializer.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["buildTtlPruneDeleteSql", "deleteExpiredRowsInBatches"].includes(node.expression.text)
      ) {
        calls.push({
          name: node.expression.text,
          owner: owner(node),
          argument: node.arguments[node.expression.text === "buildTtlPruneDeleteSql" ? 0 : 1]?.getText(source),
        });
      }
    });
    expect(targets.sort()).toEqual([
      "audit_log",
      "cost_events",
      "message_metadata",
      "session_events",
      "session_trace_blobs",
      "sessions",
    ]);
    expect(targets.some((target) => tables.has(target))).toBe(false);
    expect(calls).toEqual([
      { name: "buildTtlPruneDeleteSql", owner: "deleteExpiredRowsInBatches", argument: "spec.table" },
      { name: "deleteExpiredRowsInBatches", owner: "dbPruneStaleRows", argument: "spec" },
    ]);
  });
});

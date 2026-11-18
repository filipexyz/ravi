import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * Every provider env the request builder builds must name the provider being
 * started. Without `runtimeProviderId`, the env policy gives the provider no
 * config of its own and no login variable inherited from the daemon env, and
 * the process starts without them (`runtime/agent-env-policy.ts`).
 */
describe("runtime request builder env", () => {
  it("passes runtimeProviderId at every buildRuntimeRequestEnv call", () => {
    const path = join(import.meta.dir, "runtime-request-builder.ts");
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const calls: Array<{ line: number; hasProvider: boolean }> = [];

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "buildRuntimeRequestEnv"
      ) {
        const [options] = node.arguments;
        const hasProvider =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
              property.name.getText(source) === "runtimeProviderId",
          );
        calls.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, hasProvider });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // The baseline env, the turn env and the env rebuilt when the model broker rotates the credential.
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect({ line: call.line, hasProvider: call.hasProvider }).toEqual({ line: call.line, hasProvider: true });
    }
  });
});

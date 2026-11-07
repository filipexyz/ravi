import "reflect-metadata";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { z } from "zod";
import { SessionCommands } from "../../cli/commands/sessions.js";
import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { emitAllDart } from "../dart-codegen/index.js";
import { emit } from "../openapi/emit.js";
import { emitAllSwift } from "../swift-codegen/index.js";
import { emitAll } from "./index.js";
import { buildInputSchema } from "./registry-shape.js";

const version = { sdkVersion: "0.0.0", registryHash: "fixture", gitSha: "fixture" };

@Group({ name: "constraint", description: "Input constraint fixture", scope: "open" })
class ConstraintCommands {
  @Command({ name: "set", description: "Set one or more fields", requiredAnyOfOptions: ["model", "effort"] })
  @Returns(z.object({ ok: z.boolean() }))
  set(
    @Arg("thread") _thread: string,
    @Option({ flags: "--model <model>" }) _model?: string,
    @Option({ flags: "--effort <effort>" }) _effort?: string,
    @Option({ flags: "--session <session>" }) _session?: string,
  ) {}

  @Command({ name: "optional", description: "Optional positional", requiredAnyOfOptions: ["model", "effort"] })
  @Returns(z.object({ ok: z.boolean() }))
  optional(
    @Arg("thread", { required: false }) _thread?: string,
    @Option({ flags: "--model <model>" }) _model?: string,
    @Option({ flags: "--effort <effort>" }) _effort?: string,
  ) {}

  @Command({ name: "ordinary", description: "Unrelated command without a presence constraint" })
  @Returns(z.object({ ok: z.boolean() }))
  ordinary(@Option({ flags: "--model <model>" }) _model?: string) {}
}

/** Typecheck emitted request types in memory; never create or remove fixture files. */
function typeDiagnostics(source: string, modules: Record<string, string> = {}): string[] {
  const filename = "/virtual-ravi-contract.ts";
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const sources: Record<string, string> = { [filename]: source, ...modules };
  host.resolveModuleNames = (names) =>
    names.map((name) => {
      const path = `/${name.replace(/^\.\//, "").replace(/\.js$/, ".ts")}`;
      return path in sources ? { resolvedFileName: path, extension: ts.Extension.Ts } : undefined;
    });
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path in sources
      ? ts.createSourceFile(path, sources[path], languageVersion, true)
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("thread-configure input contract", () => {
  it("rejects non-thinking strings in the real registry and emitted input", () => {
    const registry = buildRegistry([SessionCommands]);
    const command = registry.commands.find((entry) => entry.fullName === "sessions.thread-configure")!;
    const thinking = command.options.find((option) => option.name === "thinking")!.schema;
    expect(thinking.safeParse("yes").success).toBe(false);
    const input = z.fromJSONSchema(buildInputSchema(command));
    expect(input.safeParse({ thread: "child", thinking: "yes" }).success).toBe(false);
    expect(input.safeParse({ thread: "child", thinking: " \tClEaR\n" }).success).toBe(true);
  });
  it("projects the real command's presence and thinking constraints identically to SDK and OpenAPI", () => {
    const registry = buildRegistry([SessionCommands]);
    const command = registry.commands.find((entry) => entry.fullName === "sessions.thread-configure")!;
    const sdk = buildInputSchema(command);
    const body = emit(registry).paths["/api/v1/sessions/thread-configure"].post!.requestBody!;
    const api = body.content["application/json"].schema;
    expect(api).toEqual(sdk);
    expect(command.requiredAnyOfOptions).toEqual(["effort", "model", "provider", "thinking"]);
    expect(body.required).toBe(true);
    expect(sdk.required).toEqual(["thread"]);
    expect(sdk.additionalProperties).toBe(false);
    const input = z.fromJSONSchema(sdk);
    for (const value of [
      { thread: "child" },
      { thread: "child", session: "parent" },
      { effort: "ultra" },
      { thread: "child", thinking: "yes" },
      { thread: "child", thinking: "" },
      { thread: "child", thinking: "  " },
      { thread: "child", thinking: null },
      { thread: "child", thinking: 1 },
      { thread: "child", effort: "ultra", extra: true },
    ])
      expect(input.safeParse(value).success).toBe(false);
    for (const value of [
      { thread: "child", provider: "clear" },
      { thread: "child", model: "clear" },
      { thread: "child", effort: "ultra" },
      { thread: "child", thinking: "off" },
      { thread: "child", thinking: "normal" },
      { thread: "child", thinking: "verbose" },
      { thread: "child", thinking: "clear" },
      { thread: "child", thinking: " \tVeRbOsE\n" },
      { thread: "child", model: "gpt-6-astra", effort: "ultra", thinking: "CLEAR", session: "parent" },
    ])
      expect(input.safeParse(value).success).toBe(true);
    const thinking = command.options.find((option) => option.name === "thinking")!.schema;
    expect(thinking.safeParse(undefined).success).toBe(true);
    expect(thinking.safeParse("\u00a0NoRmAl\uFEFF").success).toBe(true);
    expect(thinking.safeParse("no rmal").success).toBe(false);
  });

  it("keeps inclusive complete object branches and unchanged unrelated command schemas", () => {
    const registry = buildRegistry([ConstraintCommands]);
    const set = registry.commands.find((entry) => entry.command === "set")!;
    const schema = buildInputSchema(set);
    const branches = schema.anyOf as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.properties).toEqual(schema.properties);
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("thread");
    }
    const input = z.fromJSONSchema(schema);
    expect(input.safeParse({ thread: "t", model: "m", effort: "high" }).success).toBe(true);
    expect(input.safeParse({ thread: "t", session: "s" }).success).toBe(false);
    const ordinary = registry.commands.find((entry) => entry.command === "ordinary")!;
    expect(ordinary.requiredAnyOfOptions).toBeUndefined();
    expect(buildInputSchema(ordinary)).toEqual({
      type: "object",
      properties: { model: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("requires an HTTP body even without a required positional argument", () => {
    const registry = buildRegistry([ConstraintCommands]);
    const body = emit(registry).paths["/api/v1/constraint/optional"].post!.requestBody!;
    expect(body.required).toBe(true);
    expect(z.fromJSONSchema(body.content["application/json"].schema).safeParse({}).success).toBe(false);
  });

  it("emits useful TS input unions and required method options without losing optional positional values", () => {
    const out = emitAll(buildRegistry([ConstraintCommands]), { version });
    expect(
      typeDiagnostics(`${out.types}
      const one: ConstraintSetInput = { thread: "t", model: "m" };
      const many: ConstraintSetInput = { thread: "t", model: "m", effort: "high", session: "s" };
      // @ts-expect-error runtime field is missing
      const empty: ConstraintSetInput = { thread: "t" };
      // @ts-expect-error parent selector does not satisfy runtime requirement
      const parentOnly: ConstraintSetInput = { thread: "t", session: "s" };
      // @ts-expect-error thread is still required
      const noThread: ConstraintSetInput = { effort: "high" };
      // @ts-expect-error null is not a valid supplied field
      const nullField: ConstraintSetInput = { thread: "t", model: null };
    `),
    ).toEqual([]);
    expect(
      typeDiagnostics(
        `${out.client}
      declare const client: RaviClient;
      client.constraint.set("t", { model: "m" });
      client.constraint.set("t", { model: "m", effort: "high", session: "s" });
      client.constraint.optional(undefined, { effort: "high" });
      client.constraint.ordinary();
      // @ts-expect-error options cannot be omitted
      client.constraint.set("t");
      // @ts-expect-error options cannot be empty
      client.constraint.set("t", {});
      // @ts-expect-error parent selector does not satisfy the requirement
      client.constraint.set("t", { session: "s" });
      // @ts-expect-error null is not a runtime value
      client.constraint.set("t", { model: null });
    `,
        {
          "/types.ts": out.types,
          "/transport/types.ts": readFileSync(
            new URL("../../../packages/ravi-os-sdk/src/transport/types.ts", import.meta.url),
            "utf8",
          ),
        },
      ),
    ).toEqual([]);
    expect(out.client).toContain("set: async (thread: string, options:");
    expect(out.client).toContain("optional: async (thread: string | undefined, options:");
    expect(out.client).toContain("ordinary: async (options?:");
    expect(out.client).toContain("model: string;");
    expect(out.client).toContain("effort: string;");
  });

  it("preserves Swift and Dart option field types and requires the constrained bag", () => {
    const registry = buildRegistry([ConstraintCommands]);
    const swift = emitAllSwift(registry, { version });
    const dart = emitAllDart(registry, { version });
    expect(swift.client).toContain("_ options: ConstraintSetOptions) async throws");
    expect(swift.types).toContain("public var model: String?");
    expect(swift.types).toContain("public var effort: String?");
    expect(dart.client).toContain("String thread, ConstraintSetOptions options)");
    expect(dart.types).toContain("final String? model;");
    expect(dart.types).toContain("final String? effort;");
    expect(swift.schemas).toContain('"anyOf"');
    expect(dart.schemas).toContain('"anyOf"');
  });

  it("rejects a constrained option that actually collides with a positional argument", () => {
    @Group({ name: "collision", description: "Argument-option collision", scope: "open" })
    class Collision {
      @Command({ name: "set", description: "Invalid collision", requiredAnyOfOptions: ["thread"] })
      set(@Arg("thread") _thread: string, @Option({ flags: "--thread <thread>" }) _override?: string) {}
    }
    expect(() => buildRegistry([Collision])).toThrow("Invalid requiredAnyOfOptions");
  });

  it.each([[], ["model", "model"], ["missing"], ["thread"], ["json"]].map((names) => ({ names })))(
    "rejects invalid presence metadata $names before emission",
    ({ names }) => {
      @Group({ name: "invalid-constraint", description: "Invalid metadata", scope: "open" })
      class Invalid {
        @Command({ name: "set", description: "Invalid declaration", requiredAnyOfOptions: names })
        set(
          @Arg("thread") _thread: string,
          @Option({ flags: "--model <model>" }) _model?: string,
          @Option({ flags: "--json" }) _json?: boolean,
        ) {}
      }
      expect(() => buildRegistry([Invalid])).toThrow("Invalid requiredAnyOfOptions");
    },
  );
});

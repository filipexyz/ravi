import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { Arg, Command, Group, Option, Returns, Scope } from "../../cli/decorators.js";
import { buildRegistry, getRegistry } from "../../cli/registry-snapshot.js";
import { emit, emitJson, commandPath } from "./emit.js";
import { sortKeysDeep, stableStringify } from "./stable-stringify.js";

@Group({ name: "demo", description: "Demo commands", scope: "open" })
class DemoCommands {
  @Command({ name: "hello", description: "Say hi" })
  @Returns(z.object({ ok: z.literal(true), message: z.string() }))
  hello(
    @Arg("name", { description: "Recipient name" }) name: string,
    @Option({ flags: "--shout", description: "All caps" }) shout?: boolean,
    @Option({ flags: "--limit <n>", description: "Max greetings", defaultValue: "1" }) limit?: string,
  ) {
    void name;
    void shout;
    void limit;
  }

  @Command({ name: "secret", description: "Privileged op" })
  @Scope("admin")
  secret(@Option({ flags: "--token <t>" }) token?: string) {
    void token;
  }

  @Command({ name: "noop", description: "No inputs, no return" })
  noop() {}
}

@Group({ name: "demo.nested", description: "Nested demo", scope: "admin" })
class NestedDemo {
  @Command({ name: "show", description: "Show nested" })
  show(
    @Arg("id") id: string,
    @Arg("rest", { variadic: true, required: false, description: "Extras" }) rest?: string[],
  ) {
    void id;
    void rest;
  }
}

function fixture() {
  return buildRegistry([DemoCommands, NestedDemo]);
}

describe("openapi emit", () => {
  it("produces a 3.1.0 doc with the expected top-level shape", () => {
    const spec = emit(fixture());
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Ravi API");
    expect(typeof spec.info.version).toBe("string");
    expect(spec.info.version.length).toBeGreaterThan(0);
    expect(spec.servers?.length).toBeGreaterThan(0);
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  it("paths.length == registry.commands.length", () => {
    const reg = fixture();
    const spec = emit(reg);
    expect(Object.keys(spec.paths).length).toBe(reg.commands.length);
  });

  it("operationId is unique and matches fullName", () => {
    const reg = fixture();
    const spec = emit(reg);
    const ids = Object.values(spec.paths).map((p) => p.post.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const expectedIds = reg.commands.map((c) => c.fullName).sort();
    expect(ids.slice().sort()).toEqual(expectedIds);
  });

  it("commandPath maps to /api/v1/<segments>/<command>", () => {
    const reg = fixture();
    const helloCmd = reg.commands.find((c) => c.fullName === "demo.hello")!;
    expect(commandPath(helloCmd)).toBe("/api/v1/demo/hello");
    const nestedCmd = reg.commands.find((c) => c.fullName === "demo.nested.show")!;
    expect(commandPath(nestedCmd)).toBe("/api/v1/demo/nested/show");
  });

  it("emits security: [] for open scope and bearerAuth requirement otherwise", () => {
    const spec = emit(fixture());
    const helloOp = spec.paths["/api/v1/demo/hello"]!.post;
    expect(helloOp.security).toEqual([]);
    const secretOp = spec.paths["/api/v1/demo/secret"]!.post;
    expect(secretOp.security).toEqual([{ bearerAuth: [] }]);
    const nestedOp = spec.paths["/api/v1/demo/nested/show"]!.post;
    expect(nestedOp.security).toEqual([{ bearerAuth: [] }]);
  });

  it("includes auth error responses for non-open scopes only", () => {
    const spec = emit(fixture());
    const helloResponses = spec.paths["/api/v1/demo/hello"]!.post.responses;
    expect(helloResponses["401"]).toBeUndefined();
    expect(helloResponses["403"]).toBeUndefined();

    const secretResponses = spec.paths["/api/v1/demo/secret"]!.post.responses;
    expect(secretResponses["401"]).toBeDefined();
    expect(secretResponses["403"]).toBeDefined();
    expect(secretResponses["400"]).toBeDefined();
    expect(secretResponses["500"]).toBeDefined();
  });

  it("includes the @Returns schema in the 200 response when declared", () => {
    const spec = emit(fixture());
    const helloOp = spec.paths["/api/v1/demo/hello"]!.post;
    const schema = helloOp.responses["200"]!.content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(props.ok).toBeDefined();
    expect(props.message).toBeDefined();
  });

  it("falls back to additionalProperties: true response when no @Returns", () => {
    const spec = emit(fixture());
    const noopOp = spec.paths["/api/v1/demo/noop"]!.post;
    const schema = noopOp.responses["200"]!.content!["application/json"].schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(true);
  });

  it("emits a flat body merging args + options at top level", () => {
    const spec = emit(fixture());
    const helloOp = spec.paths["/api/v1/demo/hello"]!.post;
    const body = helloOp.requestBody!.content["application/json"].schema as Record<string, unknown>;
    expect(body.oneOf).toBeUndefined();
    expect(body.type).toBe("object");
    const props = body.properties as Record<string, unknown>;
    expect(props.name).toBeDefined();
    expect(props.shout).toBeDefined();
    expect(props.limit).toBeDefined();
    // Wrapped CLI grammar must not leak into the API surface.
    expect(props.args).toBeUndefined();
    expect(props.options).toBeUndefined();
    expect(body.required).toEqual(["name"]);
    expect(body.additionalProperties).toBe(false);
  });

  it("uses a flat body for option-only commands too", () => {
    const spec = emit(fixture());
    const secretOp = spec.paths["/api/v1/demo/secret"]!.post;
    const body = secretOp.requestBody!.content["application/json"].schema as Record<string, unknown>;
    expect(body.oneOf).toBeUndefined();
    expect(body.type).toBe("object");
    expect((body.properties as Record<string, unknown>).token).toBeDefined();
  });

  it("omits requestBody for commands with no inputs", () => {
    const spec = emit(fixture());
    const noopOp = spec.paths["/api/v1/demo/noop"]!.post;
    expect(noopOp.requestBody).toBeUndefined();
  });

  it("tags are deduped to top-level segments and sorted", () => {
    const spec = emit(fixture());
    const tagNames = (spec.tags ?? []).map((t) => t.name);
    expect(tagNames).toEqual(["demo"]);
  });

  it("is byte-identical across runs (determinism)", () => {
    const reg = fixture();
    expect(emitJson(reg)).toBe(emitJson(reg));
  });

  it("info.version (registry hash) is stable for the same input", () => {
    const reg = fixture();
    expect(emit(reg).info.version).toBe(emit(reg).info.version);
  });

  it("info.version changes when the registry changes", () => {
    @Group({ name: "extra", description: "Extra" })
    class Extra {
      @Command({ name: "ping", description: "Ping" })
      ping() {}
    }
    const baseline = emit(fixture()).info.version;
    const extended = emit(buildRegistry([DemoCommands, NestedDemo, Extra])).info.version;
    expect(extended).not.toBe(baseline);
  });

  it("emitJson output is JSON-parseable and round-trip stable", () => {
    const reg = fixture();
    const json = emitJson(reg);
    const parsed = JSON.parse(json);
    expect(parsed.openapi).toBe("3.1.0");
    expect(stableStringify(parsed)).toBe(json);
  });

  it("custom title/description/servers flow into info", () => {
    const spec = emit(fixture(), {
      title: "Custom",
      description: "Override",
      servers: [{ url: "https://api.example", description: "prod" }],
    });
    expect(spec.info.title).toBe("Custom");
    expect(spec.info.description).toBe("Override");
    expect(spec.servers).toEqual([{ url: "https://api.example", description: "prod" }]);
  });
});

describe("openapi emit (live registry)", () => {
  it("matches paths.length to live registry.commands.length (excluding cliOnly)", () => {
    const reg = getRegistry();
    const spec = emit(reg);
    const nonCliOnlyCommands = reg.commands.filter((cmd) => !cmd.cliOnly).length;
    expect(Object.keys(spec.paths).length).toBe(nonCliOnlyCommands);
    expect(spec.openapi).toBe("3.1.0");
  });

  it("every operation has a unique operationId on the live registry", () => {
    const spec = emit(getRegistry());
    const ids = Object.values(spec.paths).map((p) => p.post.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("sortKeysDeep", () => {
  it("recursively sorts object keys but preserves array order", () => {
    const input = { b: 1, a: [{ z: 1, a: 2 }, { y: 1 }] };
    const sorted = sortKeysDeep(input) as Record<string, unknown>;
    expect(Object.keys(sorted)).toEqual(["a", "b"]);
    const arr = sorted.a as Array<Record<string, unknown>>;
    expect(Object.keys(arr[0])).toEqual(["a", "z"]);
    expect(Object.keys(arr[1])).toEqual(["y"]);
  });
});

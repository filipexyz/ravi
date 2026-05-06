import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import type { ArgMetadata, OptionMetadata } from "./decorators.js";
import { inferArgSchema, inferOptionSchema, parseFlags } from "./schema-inference.js";

function arg(extra: Partial<ArgMetadata> & { name?: string } = {}): ArgMetadata {
  return {
    name: extra.name ?? "x",
    index: extra.index ?? 0,
    required: extra.required ?? true,
    ...extra,
  } as ArgMetadata;
}

function opt(extra: Partial<OptionMetadata> & { flags: string }): OptionMetadata {
  return {
    propertyKey: extra.propertyKey ?? "method",
    index: extra.index ?? 0,
    flags: extra.flags,
    description: extra.description,
    defaultValue: extra.defaultValue,
    schema: extra.schema,
  } as OptionMetadata;
}

describe("parseFlags", () => {
  it("parses bare boolean flag", () => {
    expect(parseFlags("--json")).toMatchObject({ longFlag: "--json", name: "json", kind: "boolean" });
  });

  it("parses negated boolean flag", () => {
    expect(parseFlags("--no-color")).toMatchObject({
      longFlag: "--no-color",
      name: "noColor",
      kind: "negated-boolean",
    });
  });

  it("parses flag with required value", () => {
    expect(parseFlags("--limit <n>")).toMatchObject({
      longFlag: "--limit",
      name: "limit",
      kind: "required-value",
    });
  });

  it("parses flag with optional value", () => {
    expect(parseFlags("--tag [name]")).toMatchObject({
      longFlag: "--tag",
      name: "tag",
      kind: "optional-value",
    });
  });

  it("parses variadic flag with required value", () => {
    expect(parseFlags("--items <a...>")).toMatchObject({ name: "items", kind: "variadic" });
  });

  it("parses variadic flag with optional value", () => {
    expect(parseFlags("--items [a...]")).toMatchObject({ name: "items", kind: "variadic" });
  });

  it("parses short + long flag with value", () => {
    expect(parseFlags("-l, --limit <n>")).toMatchObject({
      shortFlag: "-l",
      longFlag: "--limit",
      name: "limit",
      kind: "required-value",
    });
  });

  it("converts kebab-case long names to camelCase", () => {
    expect(parseFlags("--include-deleted")).toMatchObject({ name: "includeDeleted", kind: "boolean" });
  });

  it("throws on unparseable DSL", () => {
    expect(() => parseFlags("not a flag")).toThrow(/Cannot parse option flags/);
  });
});

describe("inferOptionSchema — booleans", () => {
  it("--json with no default produces optional boolean", () => {
    const { schema, source } = inferOptionSchema(opt({ flags: "--json" }));
    expect(source).toBe("inferred");
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(true).success).toBe(true);
    expect(schema.safeParse("true").success).toBe(false);
  });

  it("--json with explicit default false produces boolean default", () => {
    const { schema } = inferOptionSchema(opt({ flags: "--json", defaultValue: false }));
    expect(schema.parse(undefined)).toBe(false);
    expect(schema.parse(true)).toBe(true);
  });

  it("--no-color produces boolean defaulting to true", () => {
    const { schema, parsed } = inferOptionSchema(opt({ flags: "--no-color" }));
    expect(parsed.kind).toBe("negated-boolean");
    expect(schema.parse(undefined)).toBe(true);
    expect(schema.parse(false)).toBe(false);
  });
});

describe("inferOptionSchema — string-valued", () => {
  it("--limit <n> with no default produces optional string", () => {
    const { schema, parsed } = inferOptionSchema(opt({ flags: "--limit <n>" }));
    expect(parsed.kind).toBe("required-value");
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("50").success).toBe(true);
    expect(schema.safeParse(50).success).toBe(false);
  });

  it("--limit <n> with defaultValue produces string default", () => {
    const { schema } = inferOptionSchema(opt({ flags: "--mode <mode>", defaultValue: "rules" }));
    expect(schema.parse(undefined)).toBe("rules");
    expect(schema.parse("full")).toBe("full");
  });

  it("--tag [name] produces optional string", () => {
    const { schema, parsed } = inferOptionSchema(opt({ flags: "--tag [name]" }));
    expect(parsed.kind).toBe("optional-value");
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("vip").success).toBe(true);
  });
});

describe("inferOptionSchema — variadic", () => {
  it("--items <a...> produces optional array of strings", () => {
    const { schema, parsed } = inferOptionSchema(opt({ flags: "--items <a...>" }));
    expect(parsed.kind).toBe("variadic");
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(["x", "y"]).success).toBe(true);
    expect(schema.safeParse([1, 2]).success).toBe(false);
  });

  it("--items <a...> with default array produces array default", () => {
    const { schema } = inferOptionSchema(opt({ flags: "--items <a...>", defaultValue: ["a", "b"] }));
    expect(schema.parse(undefined)).toEqual(["a", "b"]);
  });
});

describe("inferOptionSchema — explicit override", () => {
  it("uses provided schema verbatim", () => {
    const explicit = z.coerce.number();
    const { schema, source } = inferOptionSchema(opt({ flags: "--limit <n>", schema: explicit }));
    expect(source).toBe("explicit");
    expect(schema).toBe(explicit);
    expect(schema.parse("42")).toBe(42);
  });
});

describe("inferArgSchema", () => {
  it("required arg defaults to z.string()", () => {
    const { schema, source } = inferArgSchema(arg());
    expect(source).toBe("inferred");
    expect(schema.safeParse("hello").success).toBe(true);
    expect(schema.safeParse(undefined).success).toBe(false);
  });

  it("optional arg returns z.string().optional()", () => {
    const { schema } = inferArgSchema(arg({ required: false }));
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse("x").success).toBe(true);
  });

  it("variadic arg returns z.array(z.string())", () => {
    const { schema } = inferArgSchema(arg({ variadic: true }));
    expect(schema.safeParse([]).success).toBe(true);
    expect(schema.safeParse(["a", "b"]).success).toBe(true);
    expect(schema.safeParse("a").success).toBe(false);
  });

  it("variadic arg with default array uses default", () => {
    const { schema } = inferArgSchema(arg({ variadic: true, defaultValue: ["z"] }));
    expect(schema.parse(undefined)).toEqual(["z"]);
  });

  it("defaultValue produces string default", () => {
    const { schema } = inferArgSchema(arg({ defaultValue: "hi" }));
    expect(schema.parse(undefined)).toBe("hi");
    expect(schema.parse("override")).toBe("override");
  });

  it("explicit schema bypasses inference", () => {
    const explicit = z.enum(["a", "b"]);
    const { schema, source } = inferArgSchema(arg({ schema: explicit }));
    expect(source).toBe("explicit");
    expect(schema).toBe(explicit);
  });
});

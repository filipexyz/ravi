import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";

import { Arg, Command, Group, Option, RequiresSkill, Returns, getReturnsMetadata } from "./decorators.js";
import { buildRegistry } from "./registry-snapshot.js";
import { inferRaviCommandSkillGate } from "./skill-gates.js";

@Group({ name: "demo", description: "Demo commands", scope: "open" })
class DemoCommands {
  @Command({ name: "hello", description: "Say hi" })
  @Returns(z.object({ ok: z.literal(true), message: z.string() }))
  hello(
    @Arg("name", { description: "Recipient name" }) name: string,
    @Option({ flags: "--shout", description: "All caps output" }) shout?: boolean,
    @Option({ flags: "--limit <n>", description: "Max greetings", defaultValue: "1" }) limit?: string,
  ) {
    return { ok: true as const, message: `${shout ? "HEY" : "hi"} ${name} (limit ${limit})` };
  }

  @Command({ name: "tags", description: "Tag stuff" })
  tags(
    @Option({ flags: "--tag [name]", description: "Tag filter" }) tag?: string,
    @Option({ flags: "--items <a...>", description: "Variadic" }) items?: string[],
    @Option({ flags: "--no-color", description: "Disable color" }) noColor?: boolean,
    @Option({ flags: "--json", description: "JSON" }) asJson?: boolean,
  ) {
    void tag;
    void items;
    void noColor;
    void asJson;
  }
}

@Group({ name: "demo.nested", description: "Nested demo", scope: "admin" })
class NestedDemo {
  @Command({ name: "show", description: "Show nested" })
  show(
    @Arg("id") id: string,
    @Arg("rest", { variadic: true, required: false, description: "Extra args" }) rest?: string[],
  ) {
    void id;
    void rest;
  }
}

@Group({ name: "demo", description: "Demo commands" })
class CollidingCommands {
  @Command({ name: "hello", description: "Collision" })
  hello() {}
}

@Group({ name: "explicit", description: "Explicit schema demo" })
class ExplicitSchemaCommands {
  @Command({ name: "run", description: "Run" })
  run(
    @Arg("id", { schema: z.string().uuid() }) id: string,
    @Option({ flags: "--count <n>", schema: z.coerce.number().int() }) count?: number,
  ) {
    void id;
    void count;
  }
}

@Group({ name: "tasks", description: "Task commands", scope: "open" })
class InferredSkillGateCommands {
  @Command({ name: "list", description: "List tasks" })
  list() {
    return {};
  }
}

@Group({ name: "custom", description: "Custom commands", scope: "open", skillGate: "custom-skill" })
class GroupSkillGateCommands {
  @Command({ name: "run", description: "Run custom" })
  run() {
    return {};
  }
}

@Group({ name: "decorated", description: "Decorated commands", scope: "open" })
class DecoratedSkillGateCommands {
  @Command({ name: "run", description: "Run decorated" })
  @RequiresSkill("decorated-skill")
  run() {
    return {};
  }
}

describe("buildRegistry", () => {
  it("walks all decorated classes and produces commands + groups", () => {
    const reg = buildRegistry([DemoCommands, NestedDemo]);
    expect(reg.groups.map((g) => g.name).sort()).toEqual(["demo", "demo.nested"]);

    const helloCmd = reg.commands.find((c) => c.fullName === "demo.hello");
    expect(helloCmd).toBeDefined();
    expect(helloCmd?.scope).toBe("open");
    expect(helloCmd?.args.map((a) => a.name)).toEqual(["name"]);
    expect(helloCmd?.options.map((o) => o.name).sort()).toEqual(["limit", "shout"]);
  });

  it("produces inferred Zod schemas for default flag DSL patterns", () => {
    const reg = buildRegistry([DemoCommands]);
    const tagsCmd = reg.commands.find((c) => c.fullName === "demo.tags")!;

    const tag = tagsCmd.options.find((o) => o.name === "tag")!;
    expect(tag.parsed.kind).toBe("optional-value");
    expect(tag.schema.safeParse("vip").success).toBe(true);

    const items = tagsCmd.options.find((o) => o.name === "items")!;
    expect(items.parsed.kind).toBe("variadic");
    expect(items.schema.safeParse(["a", "b"]).success).toBe(true);
  });

  it("strips rendering-only flags (--json, --no-color, etc.) from the snapshot", () => {
    const reg = buildRegistry([DemoCommands]);
    const tagsCmd = reg.commands.find((c) => c.fullName === "demo.tags")!;
    const optionNames = tagsCmd.options.map((o) => o.name);
    expect(optionNames).not.toContain("json");
    expect(optionNames).not.toContain("asJson");
    expect(optionNames).not.toContain("noColor");
    expect(optionNames).not.toContain("pretty");
    expect(optionNames).not.toContain("quiet");
    expect(optionNames).not.toContain("verbose");
    // Non-rendering options (tag, items) survive.
    expect(optionNames).toContain("tag");
    expect(optionNames).toContain("items");
  });

  it("captures @Returns schema on the command entry", () => {
    const reg = buildRegistry([DemoCommands]);
    const helloCmd = reg.commands.find((c) => c.fullName === "demo.hello")!;
    expect(helloCmd.returns).toBeDefined();
    const parsed = helloCmd.returns!.safeParse({ ok: true, message: "hi" });
    expect(parsed.success).toBe(true);
    const failed = helloCmd.returns!.safeParse({ ok: false });
    expect(failed.success).toBe(false);
  });

  it("@Returns metadata is recoverable directly via reflection", () => {
    const map = getReturnsMetadata(DemoCommands);
    expect(map.has("hello")).toBe(true);
    expect(map.get("hello")?.safeParse({ ok: true, message: "x" }).success).toBe(true);
  });

  it("respects explicit schema on @Arg / @Option", () => {
    const reg = buildRegistry([ExplicitSchemaCommands]);
    const cmd = reg.commands.find((c) => c.fullName === "explicit.run")!;
    const id = cmd.args.find((a) => a.name === "id")!;
    expect(id.schemaSource).toBe("explicit");
    expect(id.schema.safeParse("not-a-uuid").success).toBe(false);
    expect(id.schema.safeParse("0a0e5b88-7b6f-4cf6-9a2c-6b7e2d8d1234").success).toBe(true);

    const count = cmd.options.find((o) => o.name === "count")!;
    expect(count.schemaSource).toBe("explicit");
    expect(count.schema.parse("42")).toBe(42);
  });

  it("variadic positional arg yields array schema", () => {
    const reg = buildRegistry([NestedDemo]);
    const show = reg.commands.find((c) => c.fullName === "demo.nested.show")!;
    const rest = show.args.find((a) => a.name === "rest")!;
    expect(rest.variadic).toBe(true);
    expect(rest.schema.safeParse([]).success).toBe(true);
    expect(rest.schema.safeParse(["a", "b"]).success).toBe(true);
  });

  it("throws on duplicate (group, command) registrations", () => {
    expect(() => buildRegistry([DemoCommands, CollidingCommands])).toThrow(/CLI registry collision/);
  });

  it("skips classes without @Group metadata", () => {
    class Plain {}
    const reg = buildRegistry([Plain as unknown as new () => object, DemoCommands]);
    expect(reg.commands.every((c) => c.cls !== (Plain as unknown))).toBe(true);
  });

  it("attaches inferred and explicit skill gates to command entries", () => {
    const reg = buildRegistry([InferredSkillGateCommands, GroupSkillGateCommands, DecoratedSkillGateCommands]);

    expect(reg.commands.find((c) => c.fullName === "tasks.list")?.skillGate).toMatchObject({
      skill: "ravi-system-tasks",
      source: "inferred",
    });
    expect(reg.commands.find((c) => c.fullName === "custom.run")?.skillGate).toMatchObject({
      skill: "custom-skill",
      source: "group",
    });
    expect(reg.commands.find((c) => c.fullName === "decorated.run")?.skillGate).toMatchObject({
      skill: "decorated-skill",
      source: "decorator",
    });
  });

  it("keeps skill-loading and visibility commands exempt in shell inference", () => {
    expect(inferRaviCommandSkillGate("bin/ravi skills show ravi-system-tasks --json")).toBeUndefined();
    expect(inferRaviCommandSkillGate("ravi sessions visibility main")).toBeUndefined();
    expect(inferRaviCommandSkillGate("ravi skills install foo")).toMatchObject({
      skill: "ravi-system-skill-creator",
      source: "inferred",
    });
    expect(inferRaviCommandSkillGate("/Users/luis/dev/filipelabs/ravi.bot/bin/ravi tasks list")).toMatchObject({
      skill: "ravi-system-tasks",
      source: "inferred",
    });
    expect(inferRaviCommandSkillGate('echo "ravi tasks list"', { executables: ["echo"] })).toBeUndefined();
  });
});

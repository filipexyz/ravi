import { describe, expect, it } from "bun:test";
import { DynamicListSelectorSchema } from "./types.js";

describe("DynamicListSelectorSchema", () => {
  it("accepts a valid contact-scope selector with has-tag condition", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "cobranca:em-aberto" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid chat-scope selector with has-tag condition", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "chat",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "urgent" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts contact selector with multiple conditions", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [
        { kind: "has-tag", tag: "cobranca:em-aberto" },
        { kind: "not-has-tag", tag: "cliente:vip" },
        { kind: "status", value: "allowed" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts contact selector with has-any-tag", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-any-tag", tags: ["tag:a", "tag:b"] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts contact selector with has-all-tags", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "has-all-tags", tags: ["tag:x"] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts contact selector with last-inbound-age", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "last-inbound-age", operator: ">", duration: "7d" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts contact selector with has-chat-with nested conditions", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [
        {
          kind: "has-chat-with",
          conditions: [{ kind: "chat-type", value: "dm" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts chat selector with last-inbound-age", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "chat",
      match: "all",
      conditions: [{ kind: "last-inbound-age", operator: ">", duration: "3d" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts chat selector with message-count", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "chat",
      match: "all",
      conditions: [{ kind: "message-count", operator: ">=", value: 5 }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts chat selector with any-message-text-matches", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "chat",
      match: "all",
      conditions: [{ kind: "any-message-text-matches", pattern: "pagar", lastN: 10 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty conditions array", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown scope", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "group",
      match: "all",
      conditions: [{ kind: "has-tag", tag: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects match: any (MVP only supports all)", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "any",
      conditions: [{ kind: "has-tag", tag: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects contact condition applied to chat scope (chat-type is only valid in chat scope)", () => {
    // chat-type is a ChatCondition — should not parse under ContactConditionSchema
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "chat-type", value: "dm" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing scope", () => {
    const result = DynamicListSelectorSchema.safeParse({
      match: "all",
      conditions: [{ kind: "has-tag", tag: "x" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing conditions", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid duration format", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "last-inbound-age", operator: ">", duration: "seven-days" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid status value", () => {
    const result = DynamicListSelectorSchema.safeParse({
      scope: "contact",
      match: "all",
      conditions: [{ kind: "status", value: "unknown-status" }],
    });
    expect(result.success).toBe(false);
  });
});

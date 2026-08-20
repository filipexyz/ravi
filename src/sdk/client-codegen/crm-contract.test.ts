import { describe, expect, it, setDefaultTimeout } from "bun:test";

import { getRegistry } from "../../cli/registry-snapshot.js";
import { buildInputSchema, buildSignature } from "./registry-shape.js";

setDefaultTimeout(10_000);

describe("CRM SDK input contracts", () => {
  it("classifies durable planning as a mutation without changing the SDK signature", () => {
    const command = getRegistry().commands.find((entry) => entry.fullName === "crm.facade.plan");
    expect(command).toBeDefined();
    expect(command).toMatchObject({ scope: "writeContacts", access: { kind: "mutate", risk: "medium" } });

    const input = buildInputSchema(command!);
    expect(input.required).toEqual(["operation", "target"]);
    expect((input.properties as Record<string, unknown>).primary).toBeDefined();
  });

  it("exposes facade approval as approve(planId) without caller-supplied identity", () => {
    const command = getRegistry().commands.find((entry) => entry.fullName === "crm.facade.approve");
    expect(command).toBeDefined();

    const input = buildInputSchema(command!);
    const signature = buildSignature(command!, input);

    expect(Object.keys((input.properties ?? {}) as Record<string, unknown>)).toEqual(["planId"]);
    expect(input.required).toEqual(["planId"]);
    expect(signature.args).toEqual([{ name: "planId", type: "string", required: true, variadic: false }]);
    expect(signature.options).toEqual([]);
  });

  it("keeps facade apply identity runtime-derived for SDK consumers", () => {
    const command = getRegistry().commands.find((entry) => entry.fullName === "crm.facade.apply");
    expect(command).toBeDefined();

    const input = buildInputSchema(command!);
    expect(Object.keys((input.properties ?? {}) as Record<string, unknown>)).toEqual(["planId"]);
    expect(input.required).toEqual(["planId"]);
  });
});

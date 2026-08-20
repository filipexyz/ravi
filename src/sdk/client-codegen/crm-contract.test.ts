import { describe, expect, it } from "bun:test";

import { getRegistry } from "../../cli/registry-snapshot.js";
import { buildInputSchema, buildSignature } from "./registry-shape.js";

describe("CRM SDK input contracts", () => {
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
});

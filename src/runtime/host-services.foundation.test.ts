import { describe, expect, it } from "bun:test";
import type { SdkToolDefinition } from "../cli/tool-definitions.js";
import { projectRuntimeDynamicToolSpec } from "./host-services.js";

describe("runtime host agent-first tool catalog", () => {
  it("preserves command safety metadata at the runtime boundary", () => {
    const tool: SdkToolDefinition = {
      name: "demo_apply",
      description: "Apply a demo change",
      operationKind: "mutate",
      effectClass: "external",
      risk: "high",
      requiresConfirmation: true,
      classificationSource: "declared",
      inputSchema: { type: "object", properties: {}, required: [] },
    };

    expect(projectRuntimeDynamicToolSpec(tool)).toEqual({
      name: "demo_apply",
      description: "Apply a demo change",
      inputSchema: { type: "object", properties: {}, required: [] },
      safety: {
        operationKind: "mutate",
        effectClass: "external",
        risk: "high",
        requiresConfirmation: true,
        classificationSource: "declared",
      },
    });
  });
});

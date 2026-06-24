import { describe, expect, it } from "bun:test";
import { buildRaviRealtimeToolManifest, sanitizeRealtimeToolName } from "./realtime-tools.js";

describe("meeting realtime tools", () => {
  it("converts runtime dynamic tool specs to Realtime function tools", () => {
    const manifest = buildRaviRealtimeToolManifest({
      agentId: "ravi-meet-v0",
      sessionName: "ravi-meet-v0",
      contextId: "ctx_test",
      generatedAt: "2026-06-24T00:00:00.000Z",
      tools: [
        {
          name: "tasks_list",
          description: "List tasks",
          inputSchema: {
            type: "object",
            properties: {
              status: { type: "string", description: "Task status" },
            },
            required: [],
          },
        },
      ],
    });

    expect(manifest).toMatchObject({
      kind: "ravi.meetings.realtime_tools",
      version: 1,
      agentId: "ravi-meet-v0",
      toolCount: 1,
    });
    expect(manifest.tools[0]).toEqual({
      type: "function",
      name: "tasks_list",
      runtimeToolName: "tasks_list",
      description: "List tasks",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Task status" },
        },
        required: [],
        additionalProperties: false,
      },
    });
  });

  it("filters internal Realtime bridge tools", () => {
    const manifest = buildRaviRealtimeToolManifest({
      tools: [
        { name: "meetings_realtime-call", description: "Bridge", inputSchema: { type: "object" } },
        { name: "sessions_info", description: "Session info", inputSchema: { type: "object" } },
      ],
    });

    expect(manifest.tools.map((tool) => tool.runtimeToolName)).toEqual(["sessions_info"]);
  });

  it("sanitizes names for Realtime function-call compatibility", () => {
    expect(sanitizeRealtimeToolName("prox.calls.tools.run")).toBe("prox_calls_tools_run");
    expect(sanitizeRealtimeToolName("  ")).toBe("ravi_tool");
  });
});

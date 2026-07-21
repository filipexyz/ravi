import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import type { ContextRecord } from "../router/router-db.js";
import { runWithContext } from "./context.js";
import { Command, CommandAccess, Group, Option } from "./decorators.js";
import { extractTools } from "./tools-export.js";

@Group({ name: "negated", description: "Negated option fixture", scope: "open" })
class NegatedToolCommands {
  @Command({ name: "run", description: "Expose negated flag presence" })
  @CommandAccess({ kind: "read", resource: "negated", action: "run", risk: "low", input: ["noCache"] })
  run(@Option({ flags: "--no-cache", description: "Disable cache" }) noCache = false) {
    console.log(JSON.stringify({ noCache }));
  }
}

const context: ContextRecord = {
  contextId: "ctx_negated_test",
  contextKey: "rctx_negated_test",
  kind: "test-runtime",
  agentId: "negated-test",
  capabilities: [
    { permission: "read", objectType: "negated", objectId: "run", source: "test" },
    { permission: "execute", objectType: "group", objectId: "negated", source: "test" },
  ],
  createdAt: Date.now(),
};

describe("tools export negated options", () => {
  it("uses the same no-prefixed logical contract as CLI and gateway calls", async () => {
    const tool = extractTools([NegatedToolCommands]).find((candidate) => candidate.name === "negated_run");
    expect(tool).toBeDefined();

    const omitted = await runWithContext({ agentId: context.agentId, context }, () => tool!.handler({}));
    const present = await runWithContext({ agentId: context.agentId, context }, () => tool!.handler({ noCache: true }));

    expect(JSON.parse(omitted.content[0]?.text ?? "{}")).toEqual({ noCache: false });
    expect(JSON.parse(present.content[0]?.text ?? "{}")).toEqual({ noCache: true });
  });
});

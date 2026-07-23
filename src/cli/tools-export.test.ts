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
  capabilities: [{ permission: "read", objectType: "negated", objectId: "run", source: "test" }],
  createdAt: Date.now(),
};

@Group({ name: "media", description: "Media authorization fixture", scope: "open" })
class MediaAuthorizationCommands {
  @Command({ name: "send", description: "Send media" })
  @CommandAccess({ kind: "mutate", resource: "media", action: "send", risk: "high" })
  send() {
    console.log(JSON.stringify({ sent: true }));
  }

  @Command({ name: "remove", description: "Remove media" })
  @CommandAccess({ kind: "mutate", resource: "media", action: "remove", risk: "destructive" })
  remove() {
    console.log(JSON.stringify({ removed: true }));
  }
}

const mediaContext: ContextRecord = {
  contextId: "ctx_media_authorization_test",
  contextKey: "rctx_media_authorization_test",
  kind: "test-runtime",
  agentId: "media-test",
  capabilities: [{ permission: "mutate", objectType: "media", objectId: "send", source: "test" }],
  createdAt: Date.now(),
};

describe("tools export negated options", () => {
  it("uses one semantic grant and the same no-prefixed logical contract as CLI and gateway calls", async () => {
    const tool = extractTools([NegatedToolCommands]).find((candidate) => candidate.name === "negated_run");
    expect(tool).toBeDefined();

    const omitted = await runWithContext({ agentId: context.agentId, context }, () => tool!.handler({}));
    const present = await runWithContext({ agentId: context.agentId, context }, () => tool!.handler({ noCache: true }));

    expect(JSON.parse(omitted.content[0]?.text ?? "{}")).toEqual({ noCache: false });
    expect(JSON.parse(present.content[0]?.text ?? "{}")).toEqual({ noCache: true });
  });
});

describe("tools export provider-runtime authorization", () => {
  it("executes media send with only mutate:media:send and keeps neighboring mutations denied", async () => {
    const tools = extractTools([MediaAuthorizationCommands]);
    const send = tools.find((candidate) => candidate.name === "media_send");
    const remove = tools.find((candidate) => candidate.name === "media_remove");
    expect(send).toBeDefined();
    expect(remove).toBeDefined();

    const allowed = await runWithContext({ agentId: mediaContext.agentId, context: mediaContext }, () =>
      send!.handler({}),
    );
    expect(allowed.isError).not.toBe(true);
    expect(JSON.parse(allowed.content[0]?.text ?? "{}")).toEqual({ sent: true });

    const denied = await runWithContext({ agentId: mediaContext.agentId, context: mediaContext }, () =>
      remove!.handler({}),
    );
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain("Missing capability: mutate:media:remove");
    expect(denied.content[0]?.text).not.toContain("execute:group:media_remove");
  });
});

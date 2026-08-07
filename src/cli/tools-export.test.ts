import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import type { ContextRecord } from "../router/router-db.js";
import { ContractError, contractFail } from "./agent-contract.js";
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

@Group({ name: "contract", description: "Contract error fixture", scope: "open" })
class ContractToolCommands {
  @Command({ name: "emitted", description: "Emit then throw a contract envelope" })
  @CommandAccess({ kind: "read", resource: "contract", action: "emitted", risk: "low" })
  emitted() {
    contractFail("contract emitted", "USAGE_ERROR", "invalid tool input", {
      asJson: true,
      exitCode: 2,
      details: { acceptedFlags: ["--json"] },
    });
  }

  @Command({ name: "silent", description: "Throw a contract error directly" })
  @CommandAccess({ kind: "read", resource: "contract", action: "silent", risk: "low" })
  silent() {
    throw new ContractError("contract silent", "WRITE_REQUIRES_EXECUTE", "confirmation required", 3, {
      dryRun: true,
    });
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

const contractContext: ContextRecord = {
  contextId: "ctx_contract_transport_test",
  contextKey: "rctx_contract_transport_test",
  kind: "test-runtime",
  agentId: "contract-test",
  capabilities: [
    { permission: "read", objectType: "contract", objectId: "emitted", source: "test" },
    { permission: "read", objectType: "contract", objectId: "silent", source: "test" },
  ],
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
    expect(allowed.outcome).toBe("succeeded");
    expect(JSON.parse(allowed.content[0]?.text ?? "{}")).toEqual({ sent: true });

    const denied = await runWithContext({ agentId: mediaContext.agentId, context: mediaContext }, () =>
      remove!.handler({}),
    );
    expect(denied.isError).toBe(true);
    expect(denied).toMatchObject({ outcome: "denied", exitCode: 1 });
    expect(denied.content[0]?.text).toContain("Missing capability: mutate:media:remove");
    expect(denied.content[0]?.text).not.toContain("execute:group:media_remove");
  });
});

describe("tools export contract errors", () => {
  it("keeps an emitted contract envelope without a duplicate Error line", async () => {
    const tool = extractTools([ContractToolCommands]).find((candidate) => candidate.name === "contract_emitted");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: contractContext.agentId, context: contractContext }, () =>
      tool!.handler({}),
    );

    expect(result.isError).toBe(true);
    expect(result.outcome).toBe("usage_error");
    expect(result.exitCode).toBe(2);
    expect(result.content[0]?.text).not.toContain("Error: invalid tool input");
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      success: boolean;
      op: string;
      error: { code: string; acceptedFlags: string[] };
    };
    expect(envelope.success).toBe(false);
    expect(envelope.op).toBe("contract emitted");
    expect(envelope.error.code).toBe("USAGE_ERROR");
    expect(envelope.error.acceptedFlags).toEqual(["--json"]);
  });

  it("synthesizes the structured envelope for a directly-thrown ContractError", async () => {
    const tool = extractTools([ContractToolCommands]).find((candidate) => candidate.name === "contract_silent");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: contractContext.agentId, context: contractContext }, () =>
      tool!.handler({}),
    );

    expect(result).toMatchObject({ isError: false, outcome: "blocked", exitCode: 3 });
    expect(result.content[0]?.text).not.toContain("Error: confirmation required");
    const envelope = JSON.parse(result.content[0]?.text ?? "{}") as {
      success: boolean;
      op: string;
      error: { code: string; dryRun: boolean };
    };
    expect(envelope).toMatchObject({
      success: false,
      op: "contract silent",
      error: { code: "WRITE_REQUIRES_EXECUTE", dryRun: true },
    });
  });
});

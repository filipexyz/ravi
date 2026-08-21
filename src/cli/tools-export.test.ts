import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppsCommands } from "./commands/apps.js";
import type { ContextRecord } from "../router/router-db.js";
import { ContractError, contractDryRun, contractFail } from "./agent-contract.js";
import { fail, runWithContext } from "./context.js";
import { CliOnly, Command, CommandAccess, Group, Option, Returns } from "./decorators.js";
import { createSdkTools } from "./tool-definitions.js";
import { extractTools, generateManifest, manifestToJSON } from "./tools-export.js";
import { nats } from "../nats.js";

const previousSuppressAuditEvents = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;

beforeAll(() => {
  process.env.RAVI_SUPPRESS_AUDIT_EVENTS = "1";
});

afterAll(() => {
  if (previousSuppressAuditEvents === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
  else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = previousSuppressAuditEvents;
});

@Group({ name: "negated", description: "Negated option fixture", scope: "open" })
class NegatedToolCommands {
  @Command({ name: "run", description: "Expose negated flag presence" })
  @CommandAccess({ kind: "read", resource: "negated", action: "run", risk: "low", input: ["noCache"] })
  run(@Option({ flags: "--no-cache", description: "Disable cache" }) noCache = false) {
    console.log(JSON.stringify({ noCache }));
  }
}

@Group({ name: "quiet", description: "Effect-free inspection fixture", scope: "open" })
class QuietToolCommands {
  @Command({ name: "inspect", description: "Inspect without contacting audit transport" })
  @CommandAccess({ kind: "read", resource: "quiet", action: "inspect", risk: "low", audit: "none" })
  inspect() {
    console.log(JSON.stringify({ ok: true }));
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

const quietContext: ContextRecord = {
  contextId: "ctx_quiet_test",
  contextKey: "rctx_quiet_test",
  kind: "test-runtime",
  agentId: "quiet-test",
  capabilities: [{ permission: "read", objectType: "quiet", objectId: "inspect", source: "test" }],
  createdAt: Date.now(),
};

const quietDeniedContext: ContextRecord = {
  ...quietContext,
  contextId: "ctx_quiet_denied_test",
  contextKey: "rctx_quiet_denied_test",
  capabilities: [],
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
  @Command({ name: "boom", description: "Throw an unexpected internal error" })
  @CommandAccess({ kind: "read", resource: "contract", action: "boom", risk: "low" })
  boom() {
    throw new Error("private provider detail");
  }

  @Command({ name: "legacy", description: "Throw a legacy expected failure" })
  @CommandAccess({ kind: "read", resource: "contract", action: "legacy", risk: "low" })
  legacy() {
    fail("PRIVATE_LEGACY_VALIDATION_8K2R");
  }

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

  @Command({ name: "dry-run", description: "Render the default human dry-run before throwing" })
  @CommandAccess({ kind: "mutate", resource: "contract", action: "dry-run", risk: "high" })
  dryRun(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    contractDryRun(
      "contract dry-run",
      {
        caption: "PRIVATE_MESSAGE_8K2R",
        filePath: "C:/sentinel/private/file-9P3X.txt",
        key: "custom.password",
        value: "SENTINEL_SECRET_7M4Q",
        target: "fixture",
      },
      { asJson },
    );
  }

  @Command({ name: "missing-binary", description: "Return a missing binary response" })
  @CommandAccess({ kind: "read", resource: "contract", action: "missing-binary", risk: "low" })
  @Returns.binary()
  missingBinary() {
    return Response.json({ detail: "private binary provider detail" }, { status: 404 });
  }
}

@Group({ name: "terminal", description: "CLI-only fixture", scope: "open" })
class CliOnlyToolCommands {
  @Command({ name: "watch", description: "Owns a foreground process" })
  @CommandAccess({ kind: "read", resource: "terminal", action: "watch", risk: "low" })
  @CliOnly()
  watch() {
    process.exit(0);
  }

  @Command({ name: "status", description: "Safe request-response command" })
  @CommandAccess({ kind: "read", resource: "terminal", action: "status", risk: "low" })
  status() {
    console.log(JSON.stringify({ ok: true }));
  }
}

let confirmedEffectCount = 0;

@Group({ name: "effect-metadata", description: "Effect metadata fixture", scope: "open" })
class EffectMetadataCommands {
  @Command({ name: "apply", description: "Apply one externally visible effect" })
  @CommandAccess({
    kind: "mutate",
    resource: "effect-metadata",
    action: "apply",
    risk: "high",
    effectClass: "external",
    requiresConfirmation: true,
  })
  apply(@Option({ flags: "--execute", description: "Apply the external effect" }) execute = false) {
    if (!execute) {
      contractDryRun("effect-metadata apply", { effect: "external" }, { asJson: true });
    }
    confirmedEffectCount += 1;
    console.log(JSON.stringify({ applied: true }));
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
    { permission: "read", objectType: "contract", objectId: "boom", source: "test" },
    { permission: "read", objectType: "contract", objectId: "emitted", source: "test" },
    { permission: "read", objectType: "contract", objectId: "legacy", source: "test" },
    { permission: "read", objectType: "contract", objectId: "silent", source: "test" },
    { permission: "mutate", objectType: "contract", objectId: "dry-run", source: "test" },
    { permission: "read", objectType: "contract", objectId: "missing-binary", source: "test" },
  ],
  createdAt: Date.now(),
};

const appsContext: ContextRecord = {
  contextId: "ctx_apps_transport_test",
  contextKey: "rctx_apps_transport_test",
  kind: "test-runtime",
  agentId: "apps-test",
  capabilities: [
    { permission: "read", objectType: "apps", objectId: "show", source: "test" },
    { permission: "mutate", objectType: "apps", objectId: "run", source: "test" },
    { permission: "use", objectType: "app", objectId: "contract-missing-app", source: "test" },
  ],
  createdAt: Date.now(),
};

const effectMetadataContext: ContextRecord = {
  contextId: "ctx_effect_metadata_test",
  contextKey: "rctx_effect_metadata_test",
  kind: "test-runtime",
  agentId: "effect-metadata-test",
  capabilities: [{ permission: "mutate", objectType: "effect-metadata", objectId: "apply", source: "test" }],
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

describe("tools export surface", () => {
  it("never exports commands marked @CliOnly", () => {
    expect(extractTools([CliOnlyToolCommands]).map((tool) => tool.name)).toEqual(["terminal_status"]);
  });

  it("exports operation, effect, risk, and confirmation metadata to every agent manifest", () => {
    const tool = extractTools([EffectMetadataCommands])[0];
    expect(tool?.metadata.safety).toEqual({
      operationKind: "mutate",
      effectClass: "external",
      risk: "high",
      requiresConfirmation: true,
      classificationSource: "declared",
    });

    const expected = {
      operationKind: "mutate",
      effectClass: "external",
      risk: "high",
      requiresConfirmation: true,
      classificationSource: "declared",
    };
    expect(generateManifest([tool!])[0]).toMatchObject(expected);
    expect(JSON.parse(manifestToJSON([tool!]))[0]).toMatchObject(expected);
    expect(createSdkTools([EffectMetadataCommands])[0]).toMatchObject(expected);
  });

  it("does not contact the global audit transport for allowed or denied calls when suppressed", async () => {
    const originalEmit = nats.emit;
    let emits = 0;
    nats.emit = async () => {
      emits += 1;
    };
    try {
      const tool = extractTools([NegatedToolCommands])[0];
      await runWithContext({ agentId: context.agentId, context }, () => tool!.handler({}));

      const deniedTool = extractTools([MediaAuthorizationCommands]).find(
        (candidate) => candidate.name === "media_remove",
      );
      const denied = await runWithContext({ agentId: mediaContext.agentId, context: mediaContext }, () =>
        deniedTool!.handler({}),
      );
      expect(denied).toMatchObject({ outcome: "denied", exitCode: 1 });
      expect(emits).toBe(0);
    } finally {
      nats.emit = originalEmit;
    }
  });

  it("does not contact the global audit transport for audit:none, without global suppression", async () => {
    const originalEmit = nats.emit;
    const suppressed = process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    let emits = 0;
    nats.emit = async () => {
      emits += 1;
    };
    delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
    try {
      const tool = extractTools([QuietToolCommands])[0];
      const allowed = await runWithContext({ agentId: quietContext.agentId, context: quietContext }, () =>
        tool!.handler({}),
      );
      const denied = await runWithContext({ agentId: quietDeniedContext.agentId, context: quietDeniedContext }, () =>
        tool!.handler({}),
      );

      expect(allowed).toMatchObject({ isError: false, outcome: "succeeded" });
      expect(denied).toMatchObject({ isError: true, outcome: "denied", exitCode: 1 });
      expect(emits).toBe(0);
    } finally {
      if (suppressed === undefined) delete process.env.RAVI_SUPPRESS_AUDIT_EVENTS;
      else process.env.RAVI_SUPPRESS_AUDIT_EVENTS = suppressed;
      nats.emit = originalEmit;
    }
  });

  it("blocks a declared confirmation path before its first effect", async () => {
    confirmedEffectCount = 0;
    const tool = extractTools([EffectMetadataCommands])[0];

    const blocked = await runWithContext(
      { agentId: effectMetadataContext.agentId, context: effectMetadataContext },
      () => tool!.handler({}),
    );
    expect(blocked).toMatchObject({ isError: false, outcome: "blocked", exitCode: 3 });
    expect(JSON.parse(blocked.content[0]?.text ?? "{}")).toMatchObject({
      success: false,
      error: { code: "WRITE_REQUIRES_EXECUTE", dryRun: true },
    });
    expect(confirmedEffectCount).toBe(0);

    const applied = await runWithContext(
      { agentId: effectMetadataContext.agentId, context: effectMetadataContext },
      () => tool!.handler({ execute: true }),
    );
    expect(applied).toMatchObject({ isError: false, outcome: "succeeded" });
    expect(confirmedEffectCount).toBe(1);
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
  it("normalizes a non-success binary Response instead of returning empty success", async () => {
    const tool = extractTools([ContractToolCommands]).find((candidate) => candidate.name === "contract_missing-binary");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: contractContext.agentId, context: contractContext }, () =>
      tool!.handler({}),
    );

    expect(result).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const text = result.content[0]?.text ?? "{}";
    expect(text).not.toContain("private binary provider detail");
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      op: "contract missing-binary",
      error: { code: "RESOURCE_NOT_FOUND", message: "Binary resource was not found." },
    });
  });

  it("preserves a real AppsCommands failure as one redacted contract envelope", async () => {
    const tool = extractTools([AppsCommands]).find((candidate) => candidate.name === "apps_show");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: appsContext.agentId, context: appsContext }, () =>
      tool!.handler({ id: "contract-missing-app" }),
    );

    expect(result).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const body = JSON.parse(result.content[0]?.text ?? "{}");
    expect(body).toMatchObject({
      success: false,
      op: "apps show",
      error: { code: "not_found", message: "Ravi app was not found." },
    });
    expect(JSON.stringify(body)).not.toContain("evidence");
  });

  it("does not flatten an apps run failure into a successful tool result", async () => {
    const tool = extractTools([AppsCommands]).find((candidate) => candidate.name === "apps_run");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: appsContext.agentId, context: appsContext }, () =>
      tool!.handler({
        id: "contract-missing-app",
        operation: "check",
        args: ["PRIVATE_ARGUMENT_SENTINEL"],
        json: true,
      }),
    );

    expect(result).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const body = JSON.parse(result.content[0]?.text ?? "{}");
    expect(body).toMatchObject({
      success: false,
      op: "apps run",
      error: { code: "not_found", message: "Ravi app was not found." },
    });
    expect(JSON.stringify(body)).not.toContain("contract-missing-app");
    expect(JSON.stringify(body)).not.toContain("PRIVATE_ARGUMENT_SENTINEL");
  });

  it("returns a redacted canonical envelope for an unexpected error", async () => {
    const tool = extractTools([ContractToolCommands]).find((candidate) => candidate.name === "contract_boom");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: contractContext.agentId, context: contractContext }, () =>
      tool!.handler({}),
    );

    expect(result).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const text = result.content[0]?.text ?? "{}";
    expect(text).not.toContain("private provider detail");
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      op: "contract boom",
      error: { code: "UNHANDLED_ERROR", message: "Command failed unexpectedly." },
    });
  });

  it("converts a legacy expected failure into one canonical envelope", async () => {
    const tool = extractTools([ContractToolCommands]).find((candidate) => candidate.name === "contract_legacy");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: contractContext.agentId, context: contractContext }, () =>
      tool!.handler({}),
    );

    expect(result).toMatchObject({ isError: true, outcome: "failed", exitCode: 1 });
    const text = result.content[0]?.text ?? "{}";
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      op: "contract legacy",
      error: { code: "COMMAND_FAILED", message: "Command could not be completed." },
    });
    expect(text).not.toContain("PRIVATE_LEGACY_VALIDATION_8K2R");
  });

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

  it("replaces a default human dry-run with one parseable contract envelope", async () => {
    const tool = extractTools([ContractToolCommands]).find((candidate) => candidate.name === "contract_dry-run");
    expect(tool).toBeDefined();

    const result = await runWithContext({ agentId: contractContext.agentId, context: contractContext }, () =>
      tool!.handler({}),
    );

    expect(result).toMatchObject({ isError: false, outcome: "blocked", exitCode: 3 });
    const text = result.content[0]?.text ?? "{}";
    expect(text).not.toContain("[dry-run]");
    expect(text).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(text).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(text).not.toContain("C:/sentinel/private");
    expect(JSON.parse(text)).toMatchObject({
      success: false,
      op: "contract dry-run",
      error: {
        code: "WRITE_REQUIRES_EXECUTE",
        dryRun: true,
        plan: {
          caption: "[REDACTED:content length=20]",
          filePath: "[REDACTED:path]",
          key: "custom.password",
          value: "[REDACTED]",
          target: "fixture",
        },
      },
    });
  });
});

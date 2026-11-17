import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { join } from "node:path";
import { resolveSlackCredentialConfigFromEnv } from "../channels/slack/credentials.js";
import * as backends from "../credentials/backends.js";
import type { CredentialBrokerAuthority } from "../credentials/broker.js";
import { closeCredentialsDb, upsertCredentialConnection } from "../credentials/store.js";
import { dbCreateAgent, dbUpdateAgent, type ContextRecord } from "../router/router-db.js";
import { createRuntimeContext, revokeRuntimeContext } from "../runtime/context-registry.js";
import { writeCredentialsFile } from "../runtime/credentials-store.js";
import {
  cleanupIsolatedRaviState,
  createIsolatedRaviState,
  RAVI_RUNTIME_CONTEXT_ENV_KEYS,
} from "../test/ravi-state.js";
import { getContext, runWithContext, type ToolContext } from "./context.js";
import { Command, CommandAccess, Group } from "./decorators.js";
import { registerCommands } from "./registry.js";

let stateDir: string;
let observedContext: ToolContext | undefined;
let result: { ok: boolean; code?: string } | undefined;
let readSecret: ReturnType<typeof spyOn<typeof backends, "readSecret">>;
const envKeys = [
  ...RAVI_RUNTIME_CONTEXT_ENV_KEYS,
  "RAVI_CREDENTIALS_PATH",
  "RAVI_HOST_CLI_GATEWAY",
  "RAVI_GATEWAY_URL",
];
let savedEnv: Record<string, string | undefined>;
const bootstrapAuthority = { kind: "internal-service", service: "slack-channel-runtime" } as const;

async function consume(authority?: CredentialBrokerAuthority) {
  observedContext = getContext({ localOnly: true });
  try {
    await resolveSlackCredentialConfigFromEnv(
      {},
      {
        authority,
        channel: {
          name: "fixture-slack",
          provider: "slack",
          enabled: true,
          credentialConnection: "fixture",
          createdAt: 0,
          updatedAt: 0,
        },
      },
    );
    result = { ok: true };
  } catch (error) {
    result = { ok: false, code: (error as { code?: string }).code };
  }
}

@Group({ name: "credential-fixture", description: "Credential boundary fixture", scope: "open" })
class CredentialFixtureCommands {
  @Command({ name: "bootstrap", description: "Exercise an explicit infrastructure entrypoint" })
  @CommandAccess({ kind: "read", resource: "fixture", action: "bootstrap", risk: "low" })
  bootstrap() {
    return consume(bootstrapAuthority);
  }

  @Command({ name: "helper", description: "Exercise an unprivileged helper" })
  @CommandAccess({ kind: "read", resource: "fixture", action: "helper", risk: "low" })
  helper() {
    return consume();
  }
}

beforeEach(async () => {
  savedEnv = {};
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  stateDir = await createIsolatedRaviState("ravi-registry-credential-authority-");
  process.env.RAVI_CREDENTIALS_PATH = join(stateDir, "credentials.json");
  process.env.RAVI_HOST_CLI_GATEWAY = "0";
  observedContext = undefined;
  result = undefined;
  upsertCredentialConnection({
    provider: "slack",
    connection: "fixture",
    backend: "vault",
    secretRef: "vault:secret/test-only#token",
    status: "active",
  });
  readSecret = spyOn(backends, "readSecret").mockResolvedValue(
    JSON.stringify({
      appToken: "xapp-fixture-only",
      botToken: "xoxb-fixture-only",
    }),
  );
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  mock.restore();
  closeCredentialsDb();
  await cleanupIsolatedRaviState(stateDir);
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function installDefault(kind: "admin-bootstrap" | "cli-runtime") {
  const agentId = `fixture-${kind}`;
  dbCreateAgent({ id: agentId, cwd: stateDir });
  const context = createRuntimeContext({
    kind,
    agentId,
    capabilities: kind === "admin-bootstrap" ? [{ permission: "admin", objectType: "system", objectId: "*" }] : [],
  });
  writeCredentialsFile({
    version: 1,
    default: context.contextKey,
    contexts: {
      [context.contextKey]: {
        context_id: context.contextId,
        agent_id: agentId,
        kind,
        label: "fixture",
        issued_at: Date.now(),
        expires_at: null,
      },
    },
  });
  return context;
}

function execute(command = "bootstrap") {
  const program = new CommanderCommand();
  program.exitOverride();
  registerCommands(program, [CredentialFixtureCommands]);
  return program.parseAsync(["node", "fixture", "credential-fixture", command]);
}

describe("registry default credential provenance", () => {
  it.each(["admin-bootstrap", "cli-runtime"] as const)(
    "preserves the installed %s default while allowing explicit host bootstrap",
    async (kind) => {
      const context = installDefault(kind);
      await execute();
      expect(observedContext).toMatchObject({ contextOrigin: "default-credential", contextId: context.contextId });
      expect(result).toEqual({ ok: true });
      expect(readSecret).toHaveBeenCalledTimes(1);
    },
  );

  it("does not turn the default credential into implicit host authority for helpers", async () => {
    installDefault("cli-runtime");
    await execute("helper");
    expect(observedContext?.contextOrigin).toBe("default-credential");
    expect(result).toEqual({ ok: false, code: "caller_invalid" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each(["tool", "gateway"] as const)("never relabels an inherited %s caller", async (transport) => {
    const context = installDefault("cli-runtime");
    await runWithContext({ transport, context, agentId: context.agentId }, () => execute());
    expect(observedContext?.contextOrigin).toBeUndefined();
    expect(result).toEqual({ ok: false, code: "authorization_denied" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("does not honor default provenance when a runtime transport is present", async () => {
    const context = installDefault("cli-runtime");
    await runWithContext({ transport: "tool", context, contextOrigin: "default-credential" }, () => execute());
    expect(result).toEqual({ ok: false, code: "caller_invalid" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("refuses a revoked explicit key at the registry instead of using the installed default", async () => {
    const revoked = installDefault("cli-runtime");
    revokeRuntimeContext(revoked.contextId);
    installDefault("admin-bootstrap");
    process.env.RAVI_CONTEXT_KEY = revoked.contextKey;
    spyOn(process, "exit").mockImplementation((() => {
      throw new Error("fixture-registry-exit");
    }) as typeof process.exit);
    await expect(execute()).rejects.toThrow("fixture-registry-exit");
    expect(observedContext).toBeUndefined();
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("rejects explicit revoked env even when an old handler already cached a valid default", async () => {
    const revoked = installDefault("cli-runtime");
    revokeRuntimeContext(revoked.contextId);
    const defaultContext = installDefault("admin-bootstrap");
    process.env.RAVI_CONTEXT_KEY = revoked.contextKey;
    await runWithContext({ context: defaultContext, contextOrigin: "default-credential" }, () =>
      consume(bootstrapAuthority),
    );
    expect(result).toEqual({ ok: false, code: "caller_invalid" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("prefers a valid restricted explicit key over a broader cached default", async () => {
    const restricted = installDefault("cli-runtime");
    const defaultContext = installDefault("admin-bootstrap");
    dbUpdateAgent(defaultContext.agentId!, { defaults: { runtimePermissions: { profile: "full-access" } } });
    process.env.RAVI_CONTEXT_KEY = restricted.contextKey;
    await runWithContext({ context: defaultContext, contextOrigin: "default-credential" }, () =>
      consume(bootstrapAuthority),
    );
    expect(result).toEqual({ ok: false, code: "authorization_denied" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("refuses an explicitly supplied blank key %j instead of using cached default", async (key) => {
    const defaultContext = installDefault("admin-bootstrap");
    dbUpdateAgent(defaultContext.agentId!, { defaults: { runtimePermissions: { profile: "full-access" } } });
    process.env.RAVI_CONTEXT_KEY = key;
    await runWithContext({ context: defaultContext, contextOrigin: "default-credential" }, () =>
      consume(bootstrapAuthority),
    );
    expect(result).toEqual({ ok: false, code: "caller_invalid" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("keeps a genuine unmarked tool caller bounded even when the explicit env key is broader", async () => {
    const restricted = installDefault("cli-runtime");
    const broad = installDefault("admin-bootstrap");
    dbUpdateAgent(broad.agentId!, { defaults: { runtimePermissions: { profile: "full-access" } } });
    process.env.RAVI_CONTEXT_KEY = broad.contextKey;
    await runWithContext({ transport: "tool", context: restricted }, () => consume(bootstrapAuthority));
    expect(result).toEqual({ ok: false, code: "authorization_denied" });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it.each(["RAVI_AGENT_ID", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME"])(
    "refuses %s without a resolved caller instead of borrowing the installed default",
    async (marker) => {
      const defaultContext = installDefault("admin-bootstrap");
      dbUpdateAgent(defaultContext.agentId!, { defaults: { runtimePermissions: { profile: "full-access" } } });
      process.env[marker] = "restricted-fixture";
      expect(getContext()?.contextOrigin).toBe("default-credential");
      await execute();
      expect(observedContext?.contextOrigin).toBe("default-credential");
      expect(result).toEqual({ ok: false, code: "caller_invalid" });
      expect(readSecret).not.toHaveBeenCalled();
    },
  );

  it("keeps an inherited in-process caller without transport bound to its own authority", async () => {
    const context: ContextRecord = installDefault("cli-runtime");
    await runWithContext({ context, agentId: context.agentId }, () => execute());
    expect(observedContext?.contextOrigin).toBeUndefined();
    expect(result).toEqual({ ok: false, code: "authorization_denied" });
    expect(readSecret).not.toHaveBeenCalled();
  });
});

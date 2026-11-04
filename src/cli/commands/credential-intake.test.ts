import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CredentialIntakeCommands, type CredentialIntakeCommandDeps } from "./credential-intake.js";
import { CredentialConnectionsCommands, CredentialBrokerCommands } from "./credentials.js";
import { buildRegistry } from "../registry-snapshot.js";
import { buildRouteTable } from "../../sdk/gateway/route-table.js";
import { enforceCliCommandAccess } from "../command-access.js";
import { runWithContext, type ToolContext } from "../context.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import type { ContextRecord, ChannelConfig } from "../../router/router-db.js";

let stateDir: string;
beforeEach(async () => {
  stateDir = await createIsolatedRaviState("credential-intake-cli-");
});
afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

const target = "connection:slack:secondary";
const permission = { permission: "mutate", objectType: "credentials.requests", objectId: target };
function context(capabilities = [permission]): ToolContext {
  return {
    agentId: "intake-test",
    sessionKey: "intake-session",
    transport: "gateway",
    context: {
      contextId: "ctx_intake",
      contextKey: "rctx_fixture",
      kind: "turn-runtime",
      agentId: "intake-test",
      sessionKey: "intake-session",
      source: { channel: "slack", accountId: "slack-test", chatId: "C123ABC", threadId: "1234.000001" },
      capabilities,
      metadata: { authorityMode: "delegated" },
      createdAt: Date.now(),
    } as ContextRecord,
    source: { channel: "slack", accountId: "slack-test", chatId: "C123ABC", threadId: "1234.000001" },
  };
}

function fixture() {
  const calls: unknown[] = [];
  const ctx = context();
  const channels = {
    "slack-test": {
      name: "slack-test",
      provider: "slack",
      enabled: true,
      credentialConnection: "primary",
      defaults: {},
    } as ChannelConfig,
  };
  const deps: CredentialIntakeCommandDeps = {
    context: () => ctx,
    channels: () => channels,
    authorize: () => ({
      allowed: true,
      reason: "authorized_grantor",
      subjectType: "contact",
      subjectId: "contact-test",
    }),
    client: async () => {
      calls.push("client");
      return {
        authTest: async () => ({ ok: true, team_id: "T123ABC" }),
        postEphemeral: async (input) => {
          calls.push(input);
          return { channel: input.channel, ts: "1.2", messageId: "1.2", raw: { ok: true } };
        },
      };
    },
    create: (metadata) => {
      calls.push(metadata);
      return { ...metadata, id: "request-test", status: "open", createdAt: Date.now(), expiresAt: Date.now() + 600000 };
    },
    cancel: (() => {
      calls.push("cancel");
    }) as CredentialIntakeCommandDeps["cancel"],
  };
  return { deps, calls, ctx, channels, command: new CredentialIntakeCommands(deps) };
}

describe("credential request CLI", () => {
  it("rejects a projected Slack source without an authenticated Slack source", async () => {
    const f = fixture();
    delete f.ctx.context!.source;
    await expect(
      runWithContext(f.ctx, () =>
        f.command.request(target, "U123ABC", "Read workspace", undefined, undefined, undefined, true, true),
      ),
    ).rejects.toMatchObject({ code: "INTAKE_SLACK_CONTEXT_REQUIRED" });
    expect(f.calls).toEqual([]);
  });

  it("dry-run validates without network or durable requests", async () => {
    const f = fixture();
    await expect(
      runWithContext(f.ctx, () =>
        f.command.request(target, "U123ABC", "Read the private workspace", undefined, undefined, undefined, true),
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(f.calls).toEqual([]);
  });

  it("delivers only an ephemeral invitation in the invoking thread", async () => {
    const f = fixture();
    const result = await runWithContext(f.ctx, () =>
      f.command.request(
        target,
        "U123ABC",
        "Read the private workspace",
        "Workspace access",
        "keychain",
        "channels:read",
        true,
        true,
      ),
    );
    expect(result).toMatchObject({ target, delivery: "ephemeral" });
    expect(f.calls.at(-1)).toMatchObject({ channel: "C123ABC", user: "U123ABC", threadTs: "1234.000001" });
    expect(f.calls[1]).toMatchObject({
      teamId: "T123ABC",
      issuerAgentId: "intake-test",
      issuerContextId: "ctx_intake",
    });
    expect(JSON.stringify(result)).not.toContain("blocks");
  });

  it("refuses gateway transport before any Slack or storage call", async () => {
    const f = fixture();
    f.channels["slack-test"].defaults = { transport: "hub_gateway_v1" };
    await expect(
      runWithContext(f.ctx, () =>
        f.command.request(target, "U123ABC", "Read workspace", undefined, undefined, undefined, true, true),
      ),
    ).rejects.toMatchObject({ code: "INTAKE_TRANSPORT_UNSUPPORTED" });
    expect(f.calls).toEqual([]);
  });

  it("refuses an unauthorized human and an unknown env key", async () => {
    const f = fixture();
    f.deps.authorize = () => ({ allowed: false, reason: "unauthorized_grantor" });
    await expect(
      runWithContext(f.ctx, () =>
        f.command.request(target, "U123ABC", "Read workspace", undefined, undefined, undefined, true, true),
      ),
    ).rejects.toBeDefined();
    await expect(
      runWithContext(f.ctx, () =>
        f.command.request("env:PATH", "U123ABC", "Read workspace", undefined, undefined, undefined, true, true),
      ),
    ).rejects.toBeDefined();
    expect(f.calls).toEqual([]);
  });

  it("cancels an undelivered request and suppresses the raw Slack error", async () => {
    const f = fixture();
    f.deps.client = async () => ({
      authTest: async () => ({ ok: true, team_id: "T123ABC" }),
      postEphemeral: async () => {
        throw new Error("DO_NOT_ECHO_SLACK_BODY");
      },
    });
    let failure: unknown;
    try {
      await runWithContext(f.ctx, () =>
        f.command.request(target, "U123ABC", "Read workspace", undefined, undefined, undefined, true, true),
      );
    } catch (error) {
      failure = error;
    }
    expect(f.calls).toContain("cancel");
    expect(String(failure)).not.toContain("DO_NOT_ECHO_SLACK_BODY");
  });
});

describe("credential request gateway boundary", () => {
  const registry = buildRegistry([CredentialIntakeCommands, CredentialConnectionsCommands, CredentialBrokerCommands]);
  const request = registry.commands.find((command) => command.fullName === "credentials.request")!;

  it("remotes metadata requests and keeps all existing CLI-only credential commands excluded", () => {
    const routes = buildRouteTable(registry);
    expect(routes.byPath.has("/api/v1/credentials/request")).toBe(true);
    for (const path of ["connections/add", "connections/remove", "broker/exec"]) {
      expect(routes.byPath.has(`/api/v1/credentials/${path}`)).toBe(false);
    }
    const serialized = JSON.stringify(request.options);
    for (const flag of ["--value", "--secret", "--stdin", "--file"]) expect(serialized).not.toContain(flag);
  });

  it("exact request permission cannot set a secret, request another target or inherit group access", () => {
    const attempt = (ctx: ToolContext, requestedTarget: string, access = request.access) =>
      runWithContext(ctx, () =>
        enforceCliCommandAccess({
          group: "credentials",
          command: "request",
          access,
          input: { target: requestedTarget },
          source: "gateway",
        }),
      );
    expect(attempt(context(), target).allowed).toBe(true);
    expect(attempt(context(), "connection:slack:other").allowed).toBe(false);
    expect(
      attempt(context([{ permission: "execute", objectType: "group", objectId: "credentials" }]), target).allowed,
    ).toBe(false);
    expect(attempt(context(), target, { ...request.access!, resource: "credentials.secrets" }).allowed).toBe(false);
  });
});

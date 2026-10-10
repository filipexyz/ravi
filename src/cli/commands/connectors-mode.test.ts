/**
 * `ravi connectors mode`: whose account an agent uses for a provider. Runs the
 * real command against an isolated Ravi state, so the settings row it writes
 * (or does not write) is the one the turn gate reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { CloudAuthError } from "../../cloud-auth/errors.js";
import { writeCloudCredentials } from "../../cloud-auth/storage.js";
import { connectorModeSettingKey, readAgentConnectorMode, writeAgentConnectorMode } from "../../link/connector-mode.js";
import { dbGetSetting } from "../../router/router-db.js";
import { createRuntimeContext } from "../../runtime/context-registry.js";
import { buildSessionRelayTurnOrigin } from "../../runtime/turn-origin.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ContractError } from "../agent-contract.js";
import { cloudErrorToContractError } from "../cloud-error-contract.js";
import { ConnectorsCommands } from "./connectors.js";

const RUNTIME_ENV = ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"] as const;

let stateDir: string | null = null;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-connectors-mode-");
  savedEnv = Object.fromEntries(RUNTIME_ENV.map((name) => [name, process.env[name]]));
  for (const name of RUNTIME_ENV) delete process.env[name];
});

afterEach(async () => {
  for (const name of RUNTIME_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

type ModeResult = {
  agentId: string;
  provider: string;
  mode: string;
  previousMode: string;
  changed: boolean;
  label: string;
};

async function run(
  args: [agent: string, provider: string, mode?: string],
  options: { execute?: boolean } = {},
): Promise<{ result?: ModeResult; error?: unknown; out: string[] }> {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...items: unknown[]) => void out.push(items.map(String).join(" "));
  console.error = (...items: unknown[]) => void out.push(items.map(String).join(" "));
  try {
    const result = (await new ConnectorsCommands().mode(args[0], args[1], args[2], true, options.execute)) as
      | ModeResult
      | undefined;
    return { result, out };
  } catch (error) {
    return { error, out };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function stored(): string | null {
  return dbGetSetting(connectorModeSettingKey("main", "google"));
}

describe("ravi connectors mode", () => {
  it("shows the default mode without writing anything", async () => {
    const { result } = await run(["main", "google"]);

    expect(result).toEqual({
      agentId: "main",
      provider: "google",
      mode: "owner",
      previousMode: "owner",
      changed: false,
      label: "Only when I ask",
    });
    expect(stored()).toBeNull();
  });

  it.each([
    ["person-asking", "person_asking"],
    ["shared", "shared"],
  ] as const)("brakes %s: dry-run, exit 3, the plan, no write", async (arg, mode) => {
    const { error, out } = await run(["main", "google", arg]);

    expect(error).toBeInstanceOf(ContractError);
    const contract = error as ContractError;
    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(contract.details.plan).toMatchObject({ agentId: "main", provider: "google", from: "owner", to: mode });
    expect(JSON.parse(out.join("\n")).error.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(stored()).toBeNull();
    expect(readAgentConnectorMode("main", "google")).toBe("owner");
  });

  it("writes person-asking and shared with --execute", async () => {
    const asking = await run(["main", "google", "person-asking"], { execute: true });
    expect(asking.result).toMatchObject({ mode: "person_asking", previousMode: "owner", changed: true });
    expect(stored()).toBe("person_asking");

    const shared = await run(["main", "google", "shared"], { execute: true });
    expect(shared.result).toMatchObject({ mode: "shared", previousMode: "person_asking", changed: true });
    expect(readAgentConnectorMode("main", "google")).toBe("shared");
  });

  it("goes back to owner at once, without --execute, and removes the setting", async () => {
    writeAgentConnectorMode("main", "google", "shared");

    const { result, error } = await run(["main", "google", "owner"]);

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ mode: "owner", previousMode: "shared", changed: true, label: "Only when I ask" });
    expect(stored()).toBeNull();
  });

  it("does not brake setting the mode it already has", async () => {
    writeAgentConnectorMode("main", "google", "person_asking");

    const { result, error } = await run(["main", "google", "person_asking"]);

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ mode: "person_asking", changed: false });
  });

  it("refuses a contact turn, exit 3, before it reads or writes anything", async () => {
    writeAgentConnectorMode("main", "google", "person_asking");
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionName: "main-session",
      metadata: {
        actorPrincipal: "contact:c_ana",
        actorResolution: "resolved",
        executorAgentId: "main",
        consoleUserId: "user_ana",
        agentIdentityCompartment: "dm:5511888888888@s.whatsapp.net",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    // One after another: each run swaps console.log until it settles.
    const attempts: Array<[args: [string, string, string?], options: { execute?: boolean }]> = [
      [["main", "google", "shared"], { execute: true }],
      [["main", "google", "owner"], {}],
      [["main", "google"], {}],
    ];
    for (const [args, options] of attempts) {
      const { error, result } = await run(args, options);
      expect(result).toBeUndefined();
      expect(error).toBeInstanceOf(CloudAuthError);
      const contract = cloudErrorToContractError("connectors mode", error as CloudAuthError);
      expect(contract.exitCode).toBe(3);
      expect(contract.code).toBe("CONNECTOR_SPEAKER_NOT_OWNER");
      expect(contract.envelope().error).toMatchObject({ replyTo: "same_chat" });
      expect(String(contract.details.chatLine)).toContain("can change that");
    }
    expect(stored()).toBe("person_asking");
  });

  it("sends the owner who asks in a group to their own chat, and changes nothing", async () => {
    writeAgentConnectorMode("main", "google", "shared");
    writeCloudCredentials({
      version: 1,
      consoleUrl: "https://console.example",
      installationId: "ins_1",
      accessToken: "access-test",
      refreshToken: "refresh-test",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      refreshTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      scopes: [],
      user: { id: "user_luis", name: "Luis" },
      organization: { id: "org_1", name: "Acme" },
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
    });
    const context = createRuntimeContext({
      kind: "turn-runtime",
      agentId: "main",
      sessionName: "main-group",
      metadata: {
        actorPrincipal: "contact:c_luis",
        actorResolution: "resolved",
        executorAgentId: "main",
        consoleUserId: "user_luis",
        consoleOrgId: "org_1",
        agentIdentityCompartment: "chat:120363012345678901@g.us",
      },
    });
    process.env.RAVI_CONTEXT_KEY = context.contextKey;

    const { error, result } = await run(["main", "google", "owner"]);

    expect(result).toBeUndefined();
    const contract = cloudErrorToContractError("connectors mode", error as CloudAuthError);
    expect(contract.exitCode).toBe(3);
    expect(contract.code).toBe("CONNECTOR_GROUP_BLOCKED");
    expect(contract.details.chatLine).toBe("Ask me in our private chat and I'll change it.");
    expect(stored()).toBe("shared");
  });

  it("lets the operator's `ravi sessions send` change it, even into a session that posts into a group", async () => {
    const relayTurn = (turnReplyTarget?: Record<string, unknown>) =>
      createRuntimeContext({
        kind: "turn-runtime",
        agentId: "main",
        sessionName: "familia",
        metadata: {
          actorPrincipal: "automation:operator:local",
          actorResolution: "resolved",
          executorAgentId: "main",
          agentIdentityCompartment: "workspace:default",
          turnOrigin: buildSessionRelayTurnOrigin("send", undefined),
          ...(turnReplyTarget ? { turnReplyTarget } : {}),
        },
      });

    // The session posts the answer into the group.
    writeAgentConnectorMode("main", "google", "shared");
    process.env.RAVI_CONTEXT_KEY = relayTurn({
      kind: "chat",
      channel: "whatsapp",
      chatId: "120363012345678901@g.us",
    }).contextKey;
    const intoGroup = await run(["main", "google", "owner"]);
    expect(intoGroup.error).toBeUndefined();
    expect(intoGroup.result).toMatchObject({ mode: "owner", previousMode: "shared", changed: true });
    expect(stored()).toBeNull();

    // Ravi could not tell where the answer goes.
    process.env.RAVI_CONTEXT_KEY = relayTurn().contextKey;
    const unknown = await run(["main", "google", "person-asking"], { execute: true });
    expect(unknown.error).toBeUndefined();
    expect(unknown.result).toMatchObject({ mode: "person_asking", changed: true });
    expect(stored()).toBe("person_asking");
  });

  it("refuses an unknown provider or mode with a usage error (exit 2)", async () => {
    const provider = await run(["main", "github", "shared"], { execute: true });
    expect((provider.error as ContractError).exitCode).toBe(2);
    expect((provider.error as ContractError).details.acceptedPositionals).toEqual(["google"]);

    const mode = await run(["main", "google", "everyone"], { execute: true });
    expect((mode.error as ContractError).exitCode).toBe(2);
    expect((mode.error as ContractError).details.acceptedPositionals).toEqual(["owner", "person-asking", "shared"]);
    expect(stored()).toBeNull();
  });

  it("refuses an unknown agent (exit 1) before the brake", async () => {
    const { error } = await run(["mian", "google", "shared"]);

    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe("AGENT_NOT_FOUND");
    expect((error as ContractError).exitCode).toBe(1);
    expect((error as ContractError).details.suggestions).toContain("main");
  });
});

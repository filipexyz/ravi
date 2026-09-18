import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  assertBootstrapFloor,
  assertChatOnlyParity,
  assertChatOnlyStore,
  assertNoToolOrExecAuthority,
  materializeAgentAndIdentity,
  persistAgentRuntimeProfile,
} from "./chat-only-parity.js";
import { readAgentRuntimePermissionsConfig } from "./agent-default-capabilities-provider.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "./provider-runtime.js";
import { createClaudeRuntimeProvider } from "../runtime/claude-provider.js";
import { createCodexRuntimeProvider } from "../runtime/codex-provider.js";
import { createGrokRuntimeProvider } from "../runtime/grok-provider.js";
import { createPiRuntimeProvider } from "../runtime/pi-provider.js";

let stateDir: string | null = null;

describe("assertChatOnlyParity", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-chat-only-parity-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("keeps none as the bootstrap floor and chat-only as a stored zero-authority sentinel", async () => {
    dbCreateAgent({ id: "reception", cwd: "/tmp/reception" });
    expect(readAgentRuntimePermissionsConfig("reception")).toBeNull();
    assertBootstrapFloor(materializeSubjectCapabilities("agent", "reception"));

    await assertChatOnlyParity("reception");
    assertChatOnlyStore("reception");
  });

  it("does not let leftover explicit capabilities or empty chat policy reintroduce tools", () => {
    dbCreateAgent({ id: "leaky", cwd: "/tmp/leaky" });
    dbUpdateAgent("leaky", {
      defaults: {
        runtimePermissions: {
          profile: "chat-only",
          capabilities: ["use:tool:*", "execute:group:sessions", "execute:executable:ls"],
        },
      },
    });

    const snapshot = materializeAgentAndIdentity("leaky", "empty-surface");
    assertNoToolOrExecAuthority(snapshot.agent, "leaky leftover capabilities");
    assertNoToolOrExecAuthority(snapshot.identity, "leaky identity leftover");
    expect(canWithCapabilities(snapshot.identity, "use", "tool", "Read")).toBe(false);
    expect(snapshot.identity).toEqual([]);
  });

  it("does not apply chat-only as the birth default for a normal agent", () => {
    dbCreateAgent({ id: "main", cwd: "/tmp/main" });
    expect(readAgentRuntimePermissionsConfig("main")).toBeNull();
    assertBootstrapFloor(materializeSubjectCapabilities("agent", "main"));
    persistAgentRuntimeProfile("main", "none");
    expect(readAgentRuntimePermissionsConfig("main")).toBeNull();
    assertBootstrapFloor(materializeSubjectCapabilities("agent", "main"));
  });

  it("keeps host-enforced ravi-host permission modes on Codex, Pi, Claude, and Grok", () => {
    expect(createCodexRuntimeProvider().getCapabilities().tools).toMatchObject({
      permissionMode: "ravi-host",
      accessRequirement: "tool_surface",
    });
    expect(createPiRuntimeProvider().getCapabilities().tools.permissionMode).toBe("ravi-host");
    expect(createClaudeRuntimeProvider().getCapabilities().tools.permissionMode).toBe("ravi-host");
    expect(createGrokRuntimeProvider().getCapabilities().tools.permissionMode).toBe("ravi-host");
  });
});

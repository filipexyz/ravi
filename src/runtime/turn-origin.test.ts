import { describe, expect, it } from "bun:test";
import {
  buildChannelTurnOrigin,
  buildRuntimeCallerPrincipal,
  buildSessionRelayTurnOrigin,
  isSessionRelayTurn,
  RAVI_AUTOMATION_PRINCIPAL_ENV,
  readSpawnedAutomationPrincipal,
  resolveRuntimeTurnOrigin,
  spawnedAutomationEnv,
} from "./turn-origin.js";

describe("runtime turn origin", () => {
  it("builds an agent-authenticated session relay envelope", () => {
    expect(
      buildSessionRelayTurnOrigin("ask", {
        agentId: "origin-agent",
        sessionKey: "agent:origin-agent:main",
        sessionName: "origin",
      }),
    ).toEqual({
      protocol: "ravi.runtime.turn-origin",
      schemaVersion: 1,
      producer: "session-relay",
      action: "ask",
      principal: {
        type: "agent",
        id: "origin-agent",
      },
      session: {
        key: "agent:origin-agent:main",
        name: "origin",
      },
    });
  });

  it("uses a non-human principal for a direct operator relay", () => {
    expect(buildSessionRelayTurnOrigin("send")).toMatchObject({
      principal: {
        type: "automation",
        id: "operator:local",
      },
    });
    expect(isSessionRelayTurn({ _turnOrigin: buildSessionRelayTurnOrigin("send") })).toBe(true);
    expect(isSessionRelayTurn({})).toBe(false);
  });

  it("derives the same authenticated caller principal for any internal producer", () => {
    expect(buildRuntimeCallerPrincipal({ agentId: "origin-agent" })).toEqual({
      type: "agent",
      id: "origin-agent",
    });
    expect(buildRuntimeCallerPrincipal({ sessionKey: "agent:origin-agent:main" })).toEqual({
      type: "automation",
      id: "session:agent:origin-agent:main",
    });
  });

  it("attributes a relay from a daemon-spawned automation process to that automation", () => {
    const cronEnv = spawnedAutomationEnv("cron", "job_1");
    expect(cronEnv).toEqual({ [RAVI_AUTOMATION_PRINCIPAL_ENV]: "automation:cron:job_1" });

    // Without a runtime context and with the admin default credential alike.
    expect(buildRuntimeCallerPrincipal(undefined, cronEnv)).toEqual({ type: "automation", id: "cron:job_1" });
    expect(buildRuntimeCallerPrincipal({ agentId: "bootstrap" }, spawnedAutomationEnv("job", "j_2"))).toEqual({
      type: "automation",
      id: "job:j_2",
    });
    expect(buildRuntimeCallerPrincipal(undefined, spawnedAutomationEnv("trigger", "tr_3"))).toEqual({
      type: "automation",
      id: "trigger:tr_3",
    });
  });

  it("ignores a malformed automation marker", () => {
    expect(readSpawnedAutomationPrincipal({ [RAVI_AUTOMATION_PRINCIPAL_ENV]: "operator" })).toBeNull();
    expect(readSpawnedAutomationPrincipal({ [RAVI_AUTOMATION_PRINCIPAL_ENV]: "automation:operator:local" })).toBeNull();
    expect(buildRuntimeCallerPrincipal(undefined, { [RAVI_AUTOMATION_PRINCIPAL_ENV]: "x y" })).toEqual({
      type: "automation",
      id: "operator:local",
    });
  });

  it("accepts only known producer and action combinations", () => {
    expect(
      resolveRuntimeTurnOrigin(
        buildChannelTurnOrigin("session.bootstrap", {
          type: "automation",
          id: "operator:local",
        }),
      ),
    ).toEqual(
      buildChannelTurnOrigin("session.bootstrap", {
        type: "automation",
        id: "operator:local",
      }),
    );
    expect(
      resolveRuntimeTurnOrigin({
        protocol: "ravi.runtime.turn-origin",
        schemaVersion: 1,
        producer: "session-relay",
        action: "grant",
        principal: { type: "agent", id: "origin-agent" },
      }),
    ).toBeNull();
    expect(
      resolveRuntimeTurnOrigin({
        protocol: "ravi.runtime.turn-origin",
        schemaVersion: 1,
        producer: "channel",
        action: "whatsapp.group.create",
        principal: { type: "automation", id: "operator:local" },
      }),
    ).toBeNull();
    expect(
      resolveRuntimeTurnOrigin({
        protocol: "ravi.runtime.turn-origin",
        schemaVersion: 2,
        producer: "session-relay",
        action: "send",
        principal: { type: "agent", id: "origin-agent" },
      }),
    ).toBeNull();
  });
});

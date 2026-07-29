import { describe, expect, it } from "bun:test";
import {
  buildChannelTurnOrigin,
  buildRuntimeCallerPrincipal,
  buildSessionRelayTurnOrigin,
  resolveRuntimeTurnOrigin,
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

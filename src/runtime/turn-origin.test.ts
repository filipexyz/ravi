import { describe, expect, it } from "bun:test";
import { buildSessionRelayTurnOrigin, buildSystemTurnOrigin, resolveRuntimeTurnOrigin } from "./turn-origin.js";

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

  it("accepts only known producer and action combinations", () => {
    expect(resolveRuntimeTurnOrigin(buildSystemTurnOrigin("whatsapp.group.create"))).toEqual(
      buildSystemTurnOrigin("whatsapp.group.create"),
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
        schemaVersion: 2,
        producer: "session-relay",
        action: "send",
        principal: { type: "agent", id: "origin-agent" },
      }),
    ).toBeNull();
  });
});

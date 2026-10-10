import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { dbCreateAgent, dbDeleteAgent, dbGetSetting } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { connectorModeSettingKey, readAgentConnectorMode, writeAgentConnectorMode } from "./connector-mode.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-connector-mode-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("per-agent connector mode storage", () => {
  it("stores the wider modes and removes the row for owner", () => {
    dbCreateAgent({ id: "helper", cwd: stateDir ?? "/tmp" });

    writeAgentConnectorMode("helper", "google", "shared");
    expect(dbGetSetting(connectorModeSettingKey("helper", "google"))).toBe("shared");
    expect(readAgentConnectorMode("helper", "google")).toBe("shared");

    writeAgentConnectorMode("helper", "google", "owner");
    expect(dbGetSetting(connectorModeSettingKey("helper", "google"))).toBeNull();
    expect(readAgentConnectorMode("helper", "google")).toBe("owner");
  });

  it("forgets an agent's modes when it is deleted, so a new agent with the same id starts at owner", () => {
    dbCreateAgent({ id: "helper", cwd: stateDir ?? "/tmp" });
    dbCreateAgent({ id: "helper.eu", cwd: stateDir ?? "/tmp" });
    writeAgentConnectorMode("helper", "google", "person_asking");
    writeAgentConnectorMode("helper.eu", "google", "shared");

    expect(dbDeleteAgent("helper")).toBe(true);
    expect(dbGetSetting(connectorModeSettingKey("helper", "google"))).toBeNull();

    dbCreateAgent({ id: "helper", cwd: stateDir ?? "/tmp" });
    expect(readAgentConnectorMode("helper", "google")).toBe("owner");
    // Only that agent's keys: another agent whose id starts the same way keeps its mode.
    expect(readAgentConnectorMode("helper.eu", "google")).toBe("shared");
  });
});

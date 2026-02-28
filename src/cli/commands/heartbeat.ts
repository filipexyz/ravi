/**
 * Heartbeat Commands - Manage agent heartbeat scheduling
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import { fail } from "../context.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentHeartbeatConfig,
  updateAgentHeartbeatConfig,
  parseDuration,
  formatDuration,
  parseActiveHours,
  HEARTBEAT_PROMPT,
} from "../../heartbeat/index.js";
import { nats } from "../../nats.js";
import { publishSessionPrompt } from "../../omni/session-stream.js";
import { expandHome, getMainSession } from "../../router/index.js";
import { getAgent, getAllAgents } from "../../router/config.js";

@Group({
  name: "heartbeat",
  description: "Heartbeat scheduling management",
  scope: "admin",
})
export class HeartbeatCommands {
  @Command({ name: "status", description: "Show heartbeat status for all agents" })
  status() {
    const agents = getAllAgents();

    console.log("\nHeartbeat Status:\n");
    console.log("  AGENT           ENABLED  INTERVAL  ACTIVE HOURS      LAST RUN");
    console.log("  --------------  -------  --------  ----------------  --------------------");

    for (const agent of agents) {
      const hb = agent.heartbeat;
      const enabled = hb?.enabled ? "yes" : "no";
      const interval = hb?.intervalMs ? formatDuration(hb.intervalMs) : "-";
      const activeHours = hb?.activeStart && hb?.activeEnd ? `${hb.activeStart}-${hb.activeEnd}` : "always";
      const lastRun = hb?.lastRunAt ? new Date(hb.lastRunAt).toLocaleString() : "-";

      const id = agent.id.padEnd(14);
      const enabledStr = enabled.padEnd(7);
      const intervalStr = interval.padEnd(8);
      const hoursStr = activeHours.padEnd(16);

      console.log(`  ${id}  ${enabledStr}  ${intervalStr}  ${hoursStr}  ${lastRun}`);
    }

    console.log(`\n  Total: ${agents.length} agents`);
    console.log("\nUsage:");
    console.log("  ravi heartbeat enable <agent>              # Enable heartbeat");
    console.log("  ravi heartbeat disable <agent>             # Disable heartbeat");
    console.log("  ravi heartbeat set <agent> interval 30m    # Set interval");
    console.log("  ravi heartbeat trigger <agent>             # Manual trigger");
  }

  @Command({ name: "show", description: "Show heartbeat config for an agent" })
  show(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const hb = agent.heartbeat ?? {
      enabled: false,
      intervalMs: 1800000,
    };

    console.log(`\nHeartbeat Config: ${id}\n`);
    console.log(`  Enabled:        ${hb.enabled ? "yes" : "no"}`);
    console.log(`  Interval:       ${formatDuration(hb.intervalMs)}`);
    console.log(`  Model:          ${hb.model ?? "(agent default)"}`);
    console.log(`  Account:        ${hb.accountId ?? "(auto)"}`);
    console.log(`  Active Hours:   ${hb.activeStart && hb.activeEnd ? `${hb.activeStart}-${hb.activeEnd}` : "always"}`);
    console.log(`  Last Run:       ${hb.lastRunAt ? new Date(hb.lastRunAt).toLocaleString() : "-"}`);
    console.log(`  Workspace:      ${agent.cwd}`);

    console.log("\nThe agent will read HEARTBEAT.md from its workspace on each run.");
  }

  @Command({ name: "enable", description: "Enable heartbeat for an agent" })
  async enable(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("interval", { required: false, description: "Interval (e.g., 30m, 1h)" }) interval?: string,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    try {
      const updates: { enabled: boolean; intervalMs?: number } = { enabled: true };

      if (interval) {
        updates.intervalMs = parseDuration(interval);
      }

      updateAgentHeartbeatConfig(id, updates);

      // Signal daemon to refresh timers
      await nats.emit("ravi.heartbeat.refresh", {});

      const hb = getAgentHeartbeatConfig(id)!;
      console.log(`✓ Heartbeat enabled: ${id}`);
      console.log(`  Interval: ${formatDuration(hb.intervalMs)}`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "disable", description: "Disable heartbeat for an agent" })
  async disable(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    try {
      updateAgentHeartbeatConfig(id, { enabled: false });

      // Signal daemon to refresh timers
      await nats.emit("ravi.heartbeat.refresh", {});

      console.log(`✓ Heartbeat disabled: ${id}`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set heartbeat property" })
  async set(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("key", { description: "Property: interval, model, account, active-hours" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    try {
      switch (key) {
        case "interval": {
          const intervalMs = parseDuration(value);
          updateAgentHeartbeatConfig(id, { intervalMs });
          console.log(`✓ Interval set: ${id} -> ${formatDuration(intervalMs)}`);
          break;
        }

        case "model": {
          const model = value === "null" || value === "-" ? undefined : value;
          updateAgentHeartbeatConfig(id, { model });
          console.log(`✓ Model set: ${id} -> ${model ?? "(agent default)"}`);
          break;
        }

        case "account": {
          const accountId = value === "null" || value === "-" ? undefined : value;
          updateAgentHeartbeatConfig(id, { accountId });
          console.log(`✓ Account set: ${id} -> ${accountId ?? "(auto)"}`);
          break;
        }

        case "active-hours": {
          if (value === "null" || value === "-" || value === "always") {
            updateAgentHeartbeatConfig(id, { activeStart: undefined, activeEnd: undefined });
            console.log(`✓ Active hours cleared: ${id} (always active)`);
          } else {
            const { start, end } = parseActiveHours(value);
            updateAgentHeartbeatConfig(id, { activeStart: start, activeEnd: end });
            console.log(`✓ Active hours set: ${id} -> ${start}-${end}`);
          }
          break;
        }

        default:
          fail(`Unknown property: ${key}. Valid properties: interval, model, account, active-hours`);
      }

      // Signal daemon to refresh timers
      await nats.emit("ravi.heartbeat.refresh", {});
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "trigger", description: "Manually trigger a heartbeat" })
  async trigger(@Arg("id", { description: "Agent ID" }) id: string) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    console.log(`\nTriggering heartbeat for: ${id}`);

    try {
      // Note: Manual triggers bypass active hours check

      // Check HEARTBEAT.md exists and is not empty
      const agentCwd = expandHome(agent.cwd);
      const heartbeatFile = join(agentCwd, "HEARTBEAT.md");

      if (!existsSync(heartbeatFile)) {
        console.log("✗ No HEARTBEAT.md file found");
        console.log(`  Expected: ${heartbeatFile}`);
        return;
      }

      const content = readFileSync(heartbeatFile, "utf-8").trim();
      if (!content) {
        console.log("✗ HEARTBEAT.md is empty");
        return;
      }

      // Send heartbeat prompt using session name
      const mainSession = getMainSession(id);
      const sessionName = mainSession?.name ?? id;
      await publishSessionPrompt(sessionName, {
        prompt: HEARTBEAT_PROMPT,
        _heartbeat: true,
        _agentId: id,
      });

      console.log("✓ Heartbeat triggered");
      console.log("  Check daemon logs: ravi daemon logs -f");
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

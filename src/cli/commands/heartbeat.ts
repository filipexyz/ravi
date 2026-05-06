/**
 * Heartbeat Commands - Manage agent heartbeat scheduling
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
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
import type { AgentConfig, HeartbeatConfig } from "../../router/types.js";

const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: false,
  intervalMs: 1800000,
};

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function normalizeHeartbeatConfig(agent: AgentConfig): HeartbeatConfig {
  return agent.heartbeat ?? { ...DEFAULT_HEARTBEAT_CONFIG };
}

function formatActiveHours(config: HeartbeatConfig): string {
  return config.activeStart && config.activeEnd ? `${config.activeStart}-${config.activeEnd}` : "always";
}

function heartbeatFilePath(agent: AgentConfig): string {
  return join(expandHome(agent.cwd), "HEARTBEAT.md");
}

function serializeHeartbeatConfig(config: HeartbeatConfig) {
  return {
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    intervalDescription: formatDuration(config.intervalMs),
    model: config.model ?? null,
    accountId: config.accountId ?? null,
    activeStart: config.activeStart ?? null,
    activeEnd: config.activeEnd ?? null,
    activeHours: formatActiveHours(config),
    lastRunAt: config.lastRunAt ?? null,
  };
}

function serializeHeartbeatAgent(agent: AgentConfig) {
  const heartbeatFile = heartbeatFilePath(agent);
  return {
    agent: {
      id: agent.id,
      name: agent.name ?? null,
      cwd: agent.cwd,
      model: agent.model ?? null,
      provider: agent.provider ?? null,
    },
    heartbeat: serializeHeartbeatConfig(normalizeHeartbeatConfig(agent)),
    heartbeatFile,
    heartbeatFileExists: existsSync(heartbeatFile),
  };
}

@Group({
  name: "heartbeat",
  description: "Heartbeat scheduling management",
  scope: "admin",
})
export class HeartbeatCommands {
  @Command({ name: "status", description: "Show heartbeat status for all agents" })
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const agents = getAllAgents();
    const payload = { total: agents.length, agents: agents.map(serializeHeartbeatAgent) };

    if (asJson) {
      printJson(payload);
    } else {
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
    return payload;
  }

  @Command({ name: "show", description: "Show heartbeat config for an agent" })
  show(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    const hb = normalizeHeartbeatConfig(agent);
    const payload = serializeHeartbeatAgent(agent);

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nHeartbeat Config: ${id}\n`);
      console.log(`  Enabled:        ${hb.enabled ? "yes" : "no"}`);
      console.log(`  Interval:       ${formatDuration(hb.intervalMs)}`);
      console.log(`  Model:          ${hb.model ?? "(agent default)"}`);
      console.log(`  Account:        ${hb.accountId ?? "(auto)"}`);
      console.log(
        `  Active Hours:   ${hb.activeStart && hb.activeEnd ? `${hb.activeStart}-${hb.activeEnd}` : "always"}`,
      );
      console.log(`  Last Run:       ${hb.lastRunAt ? new Date(hb.lastRunAt).toLocaleString() : "-"}`);
      console.log(`  Workspace:      ${agent.cwd}`);

      console.log("\nThe agent will read HEARTBEAT.md from its workspace on each run.");
    }
    return payload;
  }

  @Command({ name: "enable", description: "Enable heartbeat for an agent" })
  async enable(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("interval", { required: false, description: "Interval (e.g., 30m, 1h)" }) interval?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
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

      const updatedAgent = updateAgentHeartbeatConfig(id, updates);

      // Signal daemon to refresh timers
      await nats.emit("ravi.heartbeat.refresh", {});

      const hb = getAgentHeartbeatConfig(id)!;
      const payload = {
        status: "enabled" as const,
        target: { type: "heartbeat" as const, agentId: id },
        changedCount: 1,
        ...serializeHeartbeatAgent(updatedAgent),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Heartbeat enabled: ${id}`);
        console.log(`  Interval: ${formatDuration(hb.intervalMs)}`);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "disable", description: "Disable heartbeat for an agent" })
  async disable(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    try {
      const updatedAgent = updateAgentHeartbeatConfig(id, { enabled: false });

      // Signal daemon to refresh timers
      await nats.emit("ravi.heartbeat.refresh", {});

      const payload = {
        status: "disabled" as const,
        target: { type: "heartbeat" as const, agentId: id },
        changedCount: 1,
        ...serializeHeartbeatAgent(updatedAgent),
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Heartbeat disabled: ${id}`);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set heartbeat property" })
  async set(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Arg("key", { description: "Property: interval, model, account, active-hours" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    try {
      let normalizedValue: unknown = value;
      const logHuman = (message: string) => {
        if (!asJson) console.log(message);
      };

      switch (key) {
        case "interval": {
          const intervalMs = parseDuration(value);
          updateAgentHeartbeatConfig(id, { intervalMs });
          normalizedValue = intervalMs;
          logHuman(`✓ Interval set: ${id} -> ${formatDuration(intervalMs)}`);
          break;
        }

        case "model": {
          const model = value === "null" || value === "-" ? undefined : value;
          updateAgentHeartbeatConfig(id, { model });
          normalizedValue = model ?? null;
          logHuman(`✓ Model set: ${id} -> ${model ?? "(agent default)"}`);
          break;
        }

        case "account": {
          const accountId = value === "null" || value === "-" ? undefined : value;
          updateAgentHeartbeatConfig(id, { accountId });
          normalizedValue = accountId ?? null;
          logHuman(`✓ Account set: ${id} -> ${accountId ?? "(auto)"}`);
          break;
        }

        case "active-hours": {
          if (value === "null" || value === "-" || value === "always") {
            updateAgentHeartbeatConfig(id, { activeStart: undefined, activeEnd: undefined });
            normalizedValue = null;
            logHuman(`✓ Active hours cleared: ${id} (always active)`);
          } else {
            const { start, end } = parseActiveHours(value);
            updateAgentHeartbeatConfig(id, { activeStart: start, activeEnd: end });
            normalizedValue = { activeStart: start, activeEnd: end };
            logHuman(`✓ Active hours set: ${id} -> ${start}-${end}`);
          }
          break;
        }

        default:
          fail(`Unknown property: ${key}. Valid properties: interval, model, account, active-hours`);
      }

      // Signal daemon to refresh timers
      await nats.emit("ravi.heartbeat.refresh", {});
      const updatedAgent = getAgent(id);
      const payload = {
        status: "updated" as const,
        target: { type: "heartbeat" as const, agentId: id },
        changedCount: 1,
        property: key,
        value: normalizedValue,
        ...(updatedAgent ? serializeHeartbeatAgent(updatedAgent) : { agent: { id }, heartbeat: null }),
      };
      if (asJson) {
        printJson(payload);
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "trigger", description: "Manually trigger a heartbeat" })
  async trigger(
    @Arg("id", { description: "Agent ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const agent = getAgent(id);
    if (!agent) {
      fail(`Agent not found: ${id}`);
    }

    if (!asJson) {
      console.log(`\nTriggering heartbeat for: ${id}`);
    }

    try {
      // Note: Manual triggers bypass active hours check

      // Check HEARTBEAT.md exists and is not empty
      const heartbeatFile = heartbeatFilePath(agent);

      if (!existsSync(heartbeatFile)) {
        const payload = {
          status: "skipped" as const,
          reason: "missing_heartbeat_file" as const,
          target: { type: "heartbeat" as const, agentId: id },
          changedCount: 0,
          heartbeatFile,
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log("✗ No HEARTBEAT.md file found");
          console.log(`  Expected: ${heartbeatFile}`);
        }
        return payload;
      }

      const content = readFileSync(heartbeatFile, "utf-8").trim();
      if (!content) {
        const payload = {
          status: "skipped" as const,
          reason: "empty_heartbeat_file" as const,
          target: { type: "heartbeat" as const, agentId: id },
          changedCount: 0,
          heartbeatFile,
        };
        if (asJson) {
          printJson(payload);
        } else {
          console.log("✗ HEARTBEAT.md is empty");
        }
        return payload;
      }

      // Send heartbeat prompt using session name
      const mainSession = getMainSession(id);
      const sessionName = mainSession?.name ?? id;
      await publishSessionPrompt(sessionName, {
        prompt: HEARTBEAT_PROMPT,
        _heartbeat: true,
        _agentId: id,
      });

      const payload = {
        status: "triggered" as const,
        target: { type: "heartbeat" as const, agentId: id },
        changedCount: 0,
        sessionName,
        heartbeatFile,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log("✓ Heartbeat triggered");
        console.log("  Check daemon logs: ravi daemon logs -f");
      }
      return payload;
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

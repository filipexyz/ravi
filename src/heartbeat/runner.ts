/**
 * Heartbeat Runner
 *
 * Manages per-agent heartbeat timers and tool completion triggers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { notif } from "../notif.js";
import { logger } from "../utils/logger.js";
import { dbListAgents } from "../router/router-db.js";
import { expandHome, getMainSession, getOrCreateSession, generateSessionName, ensureUniqueName, updateSessionName } from "../router/index.js";
import type { AgentConfig } from "../router/types.js";
import {
  isWithinActiveHours,
  updateAgentHeartbeatLastRun,
  HEARTBEAT_PROMPT,
} from "./config.js";

const log = logger.child("heartbeat");

interface AgentTimer {
  intervalTimer?: ReturnType<typeof setInterval>;
  lastTrigger: number;
  intervalMs: number; // Track interval to detect changes
}

/**
 * HeartbeatRunner - manages heartbeat scheduling for all agents
 */
export class HeartbeatRunner {
  private timers = new Map<string, AgentTimer>();
  private running = false;

  /**
   * Start the heartbeat runner.
   * Starts interval timers for enabled agents.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info("Starting heartbeat runner");

    // Start interval timers for enabled agents
    this.refreshTimers();

    // Subscribe to config refresh signals
    this.subscribeToConfigRefresh();

    log.info("Heartbeat runner started");
  }

  /**
   * Stop the heartbeat runner.
   * Clears all timers and stops event subscriptions.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    log.info("Stopping heartbeat runner");

    // Clear all timers
    for (const [agentId, timer] of this.timers) {
      if (timer.intervalTimer) {
        clearInterval(timer.intervalTimer);
      }
      log.debug("Cleared timer for agent", { agentId });
    }
    this.timers.clear();

    log.info("Heartbeat runner stopped");
  }

  /**
   * Refresh timers based on current agent configurations.
   * Called on startup and can be called to reload after config changes.
   */
  refreshTimers(): void {
    const agents = dbListAgents();

    // Clear existing timers for agents that are no longer enabled
    for (const [agentId, timer] of this.timers) {
      const agent = agents.find(a => a.id === agentId);
      if (!agent?.heartbeat?.enabled) {
        if (timer.intervalTimer) {
          clearInterval(timer.intervalTimer);
        }
        this.timers.delete(agentId);
        log.debug("Removed timer for disabled agent", { agentId });
      }
    }

    // Set up timers for enabled agents
    for (const agent of agents) {
      if (!agent.heartbeat?.enabled) continue;

      const existing = this.timers.get(agent.id);
      const intervalMs = agent.heartbeat.intervalMs;

      // Check if timer exists with same interval
      if (existing?.intervalTimer && existing.intervalMs === intervalMs) {
        continue; // No change needed
      }

      // Clear old timer if interval changed
      if (existing?.intervalTimer) {
        clearInterval(existing.intervalTimer);
        log.info("Interval changed, recreating timer", {
          agentId: agent.id,
          oldInterval: existing.intervalMs,
          newInterval: intervalMs,
        });
      }

      const intervalTimer = setInterval(() => {
        this.triggerHeartbeat(agent.id, "interval");
      }, intervalMs);

      this.timers.set(agent.id, {
        ...existing,
        intervalTimer,
        intervalMs,
        lastTrigger: existing?.lastTrigger ?? 0,
      });

      log.info("Started heartbeat timer", {
        agentId: agent.id,
        intervalMs,
      });
    }
  }

  /**
   * Subscribe to config refresh signals from CLI.
   */
  private async subscribeToConfigRefresh(): Promise<void> {
    const topic = "ravi.heartbeat.refresh";
    log.debug("Subscribing to config refresh", { topic });

    try {
      for await (const _event of notif.subscribe(topic)) {
        if (!this.running) break;
        log.info("Received heartbeat config refresh signal");
        this.refreshTimers();
      }
    } catch (err) {
      log.error("Config refresh subscription error", { error: err });
      if (this.running) {
        setTimeout(() => this.subscribeToConfigRefresh(), 5000);
      }
    }
  }

  /**
  /**
   * Trigger a heartbeat for an agent.
   * Performs pre-checks and sends the heartbeat prompt.
   */
  async triggerHeartbeat(agentId: string, trigger: "interval" | "manual"): Promise<boolean> {
    const agents = dbListAgents();
    const agent = agents.find(a => a.id === agentId);

    if (!agent) {
      log.warn("Agent not found for heartbeat", { agentId });
      return false;
    }

    // Check if heartbeat is enabled (for manual triggers)
    if (!agent.heartbeat?.enabled && trigger !== "manual") {
      log.debug("Heartbeat disabled for agent", { agentId });
      return false;
    }

    // Check active hours
    if (agent.heartbeat && !isWithinActiveHours(agent.heartbeat)) {
      log.debug("Outside active hours", { agentId });
      return false;
    }

    // Check HEARTBEAT.md exists and is not empty
    const agentCwd = expandHome(agent.cwd);
    const heartbeatFile = join(agentCwd, "HEARTBEAT.md");

    if (!existsSync(heartbeatFile)) {
      log.debug("No HEARTBEAT.md file", { agentId, path: heartbeatFile });
      return false;
    }

    const content = readFileSync(heartbeatFile, "utf-8").trim();
    if (!content) {
      log.debug("HEARTBEAT.md is empty", { agentId });
      return false;
    }

    log.info("Triggering heartbeat", { agentId, trigger });

    // Update last trigger time
    const timer = this.timers.get(agentId);
    const timerState = timer ?? { lastTrigger: 0, intervalMs: agent.heartbeat?.intervalMs ?? 1800000 };
    timerState.lastTrigger = Date.now();
    this.timers.set(agentId, timerState);

    // Update last run timestamp in DB
    updateAgentHeartbeatLastRun(agentId);

    // Find or create the main session for the agent
    let mainSession = getMainSession(agentId);
    if (!mainSession) {
      const agentCwd = expandHome(agent.cwd);
      const baseName = generateSessionName(agentId, { isMain: true });
      const sessionName = ensureUniqueName(baseName);
      mainSession = getOrCreateSession(
        `agent:${agentId}:main`,
        agentId,
        agentCwd,
        { name: sessionName }
      );
      if (!mainSession.name) {
        updateSessionName(mainSession.sessionKey, sessionName);
        mainSession.name = sessionName;
      }
    }

    const sessionName = mainSession.name!;

    // Send heartbeat prompt
    await notif.emit(`ravi.session.${sessionName}.prompt`, {
      prompt: HEARTBEAT_PROMPT,
      _heartbeat: true, // Mark as heartbeat for response handling
    });

    return true;
  }

  /**
   * Get status of all heartbeat timers.
   */
  getStatus(): Array<{
    agentId: string;
    enabled: boolean;
    intervalMs: number;
    lastTrigger: number;
    hasTimer: boolean;
  }> {
    const agents = dbListAgents();
    return agents.map(agent => {
      const timer = this.timers.get(agent.id);
      return {
        agentId: agent.id,
        enabled: agent.heartbeat?.enabled ?? false,
        intervalMs: agent.heartbeat?.intervalMs ?? 1800000,
        lastTrigger: timer?.lastTrigger ?? 0,
        hasTimer: !!timer?.intervalTimer,
      };
    });
  }
}

// Singleton instance
let runner: HeartbeatRunner | null = null;

/**
 * Get or create the heartbeat runner instance.
 */
export function getHeartbeatRunner(): HeartbeatRunner {
  if (!runner) {
    runner = new HeartbeatRunner();
  }
  return runner;
}

/**
 * Start the heartbeat runner.
 */
export async function startHeartbeatRunner(): Promise<void> {
  await getHeartbeatRunner().start();
}

/**
 * Stop the heartbeat runner.
 */
export async function stopHeartbeatRunner(): Promise<void> {
  if (runner) {
    await runner.stop();
    runner = null;
  }
}

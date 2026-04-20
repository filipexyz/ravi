/**
 * Cost Commands - inspect token/cost tracking recorded by Ravi
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import {
  dbGetCostSummary,
  dbGetCostByAgent,
  dbGetCostForAgent,
  dbGetCostForSession,
  dbGetTopSessions,
  getSession,
  resolveSession,
} from "../../router/index.js";

type CostSummary = {
  total_cost: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  turns: number;
};

type AgentCostRow = CostSummary & {
  agent_id: string;
  model: string;
};

type SessionCostRow = CostSummary & {
  session_key: string;
};

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function hoursToSinceMs(hours?: string): number {
  const value = Number(hours ?? "24");
  const safeHours = Number.isFinite(value) && value > 0 ? value : 24;
  return Date.now() - safeHours * 60 * 60 * 1000;
}

function normalizeHours(hours?: string): number {
  const value = Number(hours ?? "24");
  return Number.isFinite(value) && value > 0 ? value : 24;
}

function totalTokens(summary: CostSummary): number {
  return summary.total_input + summary.total_output + summary.total_cache_read + summary.total_cache_creation;
}

function buildWindowJson(hours?: string): Record<string, unknown> {
  const effectiveHours = normalizeHours(hours);
  const sinceMs = Date.now() - effectiveHours * 60 * 60 * 1000;
  return {
    requestedHours: hours ?? null,
    effectiveHours,
    sinceMs,
    untilMs: Date.now(),
  };
}

function buildSummaryJson(summary: CostSummary): CostSummary & { total_tokens: number } {
  return {
    ...summary,
    total_tokens: totalTokens(summary),
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function printSummary(label: string, summary: CostSummary): void {
  console.log(`\n${label}\n`);
  console.log(`  Cost:         ${formatUsd(summary.total_cost)}`);
  console.log(`  Turns:        ${summary.turns}`);
  console.log(`  Input:        ${formatTokens(summary.total_input)}`);
  console.log(`  Output:       ${formatTokens(summary.total_output)}`);
  console.log(`  Cache read:   ${formatTokens(summary.total_cache_read)}`);
  console.log(`  Cache write:  ${formatTokens(summary.total_cache_creation)}`);
  console.log(
    `  Total tokens: ${formatTokens(
      summary.total_input + summary.total_output + summary.total_cache_read + summary.total_cache_creation,
    )}`,
  );
  console.log();
}

@Group({
  name: "costs",
  description: "Inspect token and cost tracking",
  scope: "open",
})
export class CostCommands {
  @Command({ name: "summary", description: "Show total cost summary for a recent window" })
  summary(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const summary = dbGetCostSummary(sinceMs) as CostSummary;
    if (asJson) {
      const payload = {
        window: buildWindowJson(hours),
        summary: buildSummaryJson(summary),
      };
      printJson(payload);
      return payload;
    }
    printSummary(`Cost Summary (${hours ?? "24"}h)`, summary);
    return summary;
  }

  @Command({ name: "agents", description: "Show cost breakdown by agent" })
  agents(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--limit <n>", description: "Max agents to show (default: 20)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const rows = dbGetCostByAgent(sinceMs) as AgentCostRow[];
    const max = Math.max(1, Number(limit ?? "20") || 20);
    const byAgent = new Map<
      string,
      {
        total_cost: number;
        total_input: number;
        total_output: number;
        total_cache_read: number;
        total_cache_creation: number;
        turns: number;
        models: Set<string>;
      }
    >();

    for (const row of rows) {
      const current = byAgent.get(row.agent_id) ?? {
        total_cost: 0,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_creation: 0,
        turns: 0,
        models: new Set<string>(),
      };
      current.total_cost += row.total_cost;
      current.total_input += row.total_input;
      current.total_output += row.total_output;
      current.total_cache_read += row.total_cache_read;
      current.total_cache_creation += row.total_cache_creation;
      current.turns += row.turns;
      current.models.add(row.model);
      byAgent.set(row.agent_id, current);
    }

    const items = [...byAgent.entries()]
      .map(([agentId, data]) => ({ agentId, ...data, models: [...data.models].sort() }))
      .sort((a, b) => b.total_cost - a.total_cost)
      .slice(0, max);

    if (asJson) {
      const payload = {
        window: buildWindowJson(hours),
        limit: max,
        totalAgents: byAgent.size,
        agents: items.map((item) => ({
          agentId: item.agentId,
          ...buildSummaryJson(item),
          models: item.models,
        })),
      };
      printJson(payload);
      return payload;
    }

    console.log(`\nCost By Agent (${hours ?? "24"}h)\n`);
    console.log("  AGENT                 COST       TURNS   TOKENS      MODELS");
    console.log("  ────────────────────  ─────────  ──────  ──────────  ──────");
    for (const item of items) {
      console.log(
        `  ${item.agentId.padEnd(20)}  ${formatUsd(item.total_cost).padStart(9)}  ${String(item.turns).padStart(
          6,
        )}  ${formatTokens(totalTokens(item)).padStart(10)}  ${String(item.models.length).padStart(6)}`,
      );
    }
    console.log();
    return items;
  }

  @Command({ name: "top-sessions", description: "Show most expensive sessions" })
  topSessions(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--limit <n>", description: "Max sessions to show (default: 10)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const max = Math.max(1, Number(limit ?? "10") || 10);
    const rows = dbGetTopSessions(sinceMs, max) as SessionCostRow[];

    const items = rows.map((row) => {
      const session = getSession(row.session_key);
      const name = session?.name ?? row.session_key;
      const agentId = session?.agentId ?? "-";
      return {
        sessionKey: row.session_key,
        sessionName: session?.name ?? null,
        name,
        agentId,
        ...buildSummaryJson(row),
      };
    });

    if (asJson) {
      const payload = {
        window: buildWindowJson(hours),
        limit: max,
        sessions: items,
      };
      printJson(payload);
      return payload;
    }

    console.log(`\nTop Sessions (${hours ?? "24"}h)\n`);
    console.log("  SESSION                          AGENT         COST       TURNS   TOKENS");
    console.log("  ───────────────────────────────  ────────────  ─────────  ──────  ──────────");

    for (const item of items) {
      console.log(
        `  ${item.name.slice(0, 31).padEnd(31)}  ${item.agentId.slice(0, 12).padEnd(12)}  ${formatUsd(
          item.total_cost,
        ).padStart(9)}  ${String(item.turns).padStart(6)}  ${formatTokens(item.total_tokens).padStart(10)}`,
      );
    }

    console.log();
    return items;
  }

  @Command({ name: "agent", description: "Show detailed cost summary for one agent" })
  agent(
    @Arg("agentId", { description: "Agent ID" }) agentId: string,
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const summary = dbGetCostForAgent(agentId, sinceMs) as CostSummary;
    if (asJson) {
      const payload = {
        agentId,
        window: buildWindowJson(hours),
        summary: buildSummaryJson(summary),
      };
      printJson(payload);
      return payload;
    }
    printSummary(`Agent Cost (${agentId}, ${hours ?? "24"}h)`, summary);
    return summary;
  }

  @Command({ name: "session", description: "Show detailed cost summary for one session" })
  session(
    @Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = resolveSession(nameOrKey);
    const sessionKey = session?.sessionKey ?? nameOrKey;
    const summary = dbGetCostForSession(sessionKey) as CostSummary;
    const payload = {
      sessionKey,
      sessionName: session?.name ?? null,
      agentId: session?.agentId ?? null,
      summary: buildSummaryJson(summary),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printSummary(`Session Cost (${session?.name ?? sessionKey})`, summary);
    return payload;
  }
}

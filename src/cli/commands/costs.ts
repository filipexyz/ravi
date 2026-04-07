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

function hoursToSinceMs(hours?: string): number {
  const value = Number(hours ?? "24");
  const safeHours = Number.isFinite(value) && value > 0 ? value : 24;
  return Date.now() - safeHours * 60 * 60 * 1000;
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
  summary(@Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string) {
    const sinceMs = hoursToSinceMs(hours);
    const summary = dbGetCostSummary(sinceMs) as CostSummary;
    printSummary(`Cost Summary (${hours ?? "24"}h)`, summary);
    return summary;
  }

  @Command({ name: "agents", description: "Show cost breakdown by agent" })
  agents(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--limit <n>", description: "Max agents to show (default: 20)" }) limit?: string,
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
      .map(([agentId, data]) => ({ agentId, ...data }))
      .sort((a, b) => b.total_cost - a.total_cost)
      .slice(0, max);

    console.log(`\nCost By Agent (${hours ?? "24"}h)\n`);
    console.log("  AGENT                 COST       TURNS   TOKENS      MODELS");
    console.log("  ────────────────────  ─────────  ──────  ──────────  ──────");
    for (const item of items) {
      const totalTokens = item.total_input + item.total_output + item.total_cache_read + item.total_cache_creation;
      console.log(
        `  ${item.agentId.padEnd(20)}  ${formatUsd(item.total_cost).padStart(9)}  ${String(item.turns).padStart(
          6,
        )}  ${formatTokens(totalTokens).padStart(10)}  ${String(item.models.size).padStart(6)}`,
      );
    }
    console.log();
    return items;
  }

  @Command({ name: "top-sessions", description: "Show most expensive sessions" })
  topSessions(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--limit <n>", description: "Max sessions to show (default: 10)" }) limit?: string,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const max = Math.max(1, Number(limit ?? "10") || 10);
    const rows = dbGetTopSessions(sinceMs, max) as SessionCostRow[];

    console.log(`\nTop Sessions (${hours ?? "24"}h)\n`);
    console.log("  SESSION                          AGENT         COST       TURNS   TOKENS");
    console.log("  ───────────────────────────────  ────────────  ─────────  ──────  ──────────");

    const items = rows.map((row) => {
      const session = getSession(row.session_key);
      const name = session?.name ?? row.session_key;
      const agentId = session?.agentId ?? "-";
      const totalTokens = row.total_input + row.total_output + row.total_cache_read + row.total_cache_creation;
      console.log(
        `  ${name.slice(0, 31).padEnd(31)}  ${agentId.slice(0, 12).padEnd(12)}  ${formatUsd(row.total_cost).padStart(
          9,
        )}  ${String(row.turns).padStart(6)}  ${formatTokens(totalTokens).padStart(10)}`,
      );
      return {
        sessionKey: row.session_key,
        name,
        agentId,
        ...row,
      };
    });

    console.log();
    return items;
  }

  @Command({ name: "agent", description: "Show detailed cost summary for one agent" })
  agent(
    @Arg("agentId", { description: "Agent ID" }) agentId: string,
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const summary = dbGetCostForAgent(agentId, sinceMs) as CostSummary;
    printSummary(`Agent Cost (${agentId}, ${hours ?? "24"}h)`, summary);
    return summary;
  }

  @Command({ name: "session", description: "Show detailed cost summary for one session" })
  session(@Arg("nameOrKey", { description: "Session name or key" }) nameOrKey: string) {
    const session = resolveSession(nameOrKey);
    const sessionKey = session?.sessionKey ?? nameOrKey;
    const summary = dbGetCostForSession(sessionKey) as CostSummary;
    printSummary(`Session Cost (${session?.name ?? sessionKey})`, summary);
    return {
      sessionKey,
      sessionName: session?.name,
      agentId: session?.agentId,
      ...summary,
    };
  }
}

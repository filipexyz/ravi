/**
 * Metrics CLI - daily roll-ups of cost + activity from session_events / cost_events.
 */

import "reflect-metadata";
import { z } from "zod";
import { Command, Group, Option, Scope } from "../decorators.js";
import {
  type DailyMetricsRow,
  getDailyMetrics,
  getRolledUpDates,
  rollupDailyMetrics,
  utcDateString,
} from "../../metrics/rollup.js";
import { declareCommandReturns } from "./operational-return-schemas.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface AggregateRow {
  agentId: string;
  model: string;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costEventCount: number;
  turnsComplete: number;
  turnsFailed: number;
  turnsInterrupted: number;
  toolCalls: number;
  toolErrors: number;
  totalDurationMs: number;
}

function aggregateRows(rows: DailyMetricsRow[], by: "agent" | "agent-model" | "date"): AggregateRow[] {
  const map = new Map<string, AggregateRow>();
  for (const row of rows) {
    const key = by === "agent" ? row.agentId : by === "date" ? row.date : `${row.agentId}::${row.model}`;
    const display =
      by === "agent"
        ? { agentId: row.agentId, model: "<all>" }
        : by === "date"
          ? { agentId: row.date, model: "<all>" }
          : { agentId: row.agentId, model: row.model };

    let agg = map.get(key);
    if (!agg) {
      agg = {
        ...display,
        totalCostUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costEventCount: 0,
        turnsComplete: 0,
        turnsFailed: 0,
        turnsInterrupted: 0,
        toolCalls: 0,
        toolErrors: 0,
        totalDurationMs: 0,
      };
      map.set(key, agg);
    }
    agg.totalCostUsd += row.totalCostUsd;
    agg.inputTokens += row.inputTokens;
    agg.outputTokens += row.outputTokens;
    agg.cacheReadTokens += row.cacheReadTokens;
    agg.cacheCreationTokens += row.cacheCreationTokens;
    agg.costEventCount += row.costEventCount;
    agg.turnsComplete += row.turnsComplete;
    agg.turnsFailed += row.turnsFailed;
    agg.turnsInterrupted += row.turnsInterrupted;
    agg.toolCalls += row.toolCalls;
    agg.toolErrors += row.toolErrors;
    agg.totalDurationMs += row.totalDurationMs;
  }
  return [...map.values()].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(2)}`;
  if (usd >= 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function resolveSinceArg(daysOrDate: string | undefined): string | undefined {
  if (!daysOrDate) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(daysOrDate)) return daysOrDate;
  const days = Number.parseInt(daysOrDate, 10);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  return utcDateString(Date.now() - days * DAY_MS);
}

@Group({
  name: "metrics",
  description: "Daily metrics rollup and reporting",
})
export class MetricsCommands {
  @Scope("superadmin")
  @Command({
    name: "rollup",
    description: "Aggregate cost_events + session_events into daily_metrics for a date range",
  })
  async rollup(
    @Option({ flags: "--since <date|days>", description: "Start date YYYY-MM-DD or N days ago" })
    sinceRaw?: string,
    @Option({ flags: "--through <date>", description: "End date YYYY-MM-DD (default: yesterday UTC)" })
    through?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<{ dates: string[]; rowsWritten: number }> {
    const since = resolveSinceArg(sinceRaw);
    const result = rollupDailyMetrics({
      ...(since ? { since } : {}),
      ...(through ? { through } : {}),
    });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Rolled up ${result.dates.length} days, wrote ${result.rowsWritten} (agent, model) rows`);
      if (result.dates.length > 0) {
        console.log(`  range: ${result.dates[0]} → ${result.dates[result.dates.length - 1]}`);
      }
    }
    return result;
  }

  @Scope("superadmin")
  @Command({ name: "show", description: "Display daily metrics rolled up to date" })
  async show(
    @Option({ flags: "--agent <id>", description: "Filter to one agent" }) agentId?: string,
    @Option({ flags: "--days <n>", description: "Last N days (default: 7)" }) daysRaw?: string,
    @Option({ flags: "--since <date>", description: "Override start date YYYY-MM-DD" }) sinceRaw?: string,
    @Option({ flags: "--through <date>", description: "Override end date YYYY-MM-DD" }) through?: string,
    @Option({
      flags: "--by <dim>",
      description: "Group by 'agent' | 'agent-model' | 'date' (default: agent-model)",
    })
    byRaw?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ): Promise<DailyMetricsRow[]> {
    const days = daysRaw ? Math.max(1, Number.parseInt(daysRaw, 10) || 7) : 7;
    const since = sinceRaw ?? utcDateString(Date.now() - days * DAY_MS);
    const by = byRaw === "agent" || byRaw === "date" ? byRaw : "agent-model";

    const rows = getDailyMetrics({
      ...(agentId ? { agentId } : {}),
      since,
      ...(through ? { through } : {}),
    });

    if (asJson) {
      console.log(JSON.stringify(rows, null, 2));
      return rows;
    }

    if (rows.length === 0) {
      console.log("No rolled-up metrics in range. Run `ravi metrics rollup` first.");
      return rows;
    }

    const aggregated = aggregateRows(rows, by);
    const totalCost = aggregated.reduce((s, r) => s + r.totalCostUsd, 0);

    const headerLeft = by === "date" ? "Date" : "Agent";
    const headerMid = by === "agent-model" ? "Model" : "";
    console.log(
      `${headerLeft.padEnd(28)} ${headerMid.padEnd(20)} ${"Cost".padStart(10)} ${"In".padStart(8)} ${"Out".padStart(8)} ${"Cache".padStart(8)} ${"Turns".padStart(7)} ${"Tool✗/✓".padStart(10)}`,
    );
    console.log("-".repeat(110));
    for (const r of aggregated) {
      const turns = r.turnsComplete + r.turnsFailed + r.turnsInterrupted;
      const toolStr = `${r.toolErrors}/${r.toolCalls}`;
      console.log(
        `${r.agentId.padEnd(28)} ${(by === "agent-model" ? r.model : "").padEnd(20)} ${formatCost(r.totalCostUsd).padStart(10)} ${formatTokens(r.inputTokens).padStart(8)} ${formatTokens(r.outputTokens).padStart(8)} ${formatTokens(r.cacheReadTokens).padStart(8)} ${String(turns).padStart(7)} ${toolStr.padStart(10)}`,
      );
    }
    console.log("-".repeat(110));
    console.log(`Total cost: ${formatCost(totalCost)} across ${rows.length} rolled-up rows`);
    console.log(`Range: ${since} → ${through ?? utcDateString(Date.now())}`);

    return rows;
  }

  @Scope("superadmin")
  @Command({ name: "dates", description: "List dates that have already been rolled up" })
  async dates(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean): Promise<string[]> {
    const dates = getRolledUpDates();
    if (asJson) {
      console.log(JSON.stringify(dates, null, 2));
    } else if (dates.length === 0) {
      console.log("(no rolled-up dates yet)");
    } else {
      console.log(`${dates.length} rolled-up dates:`);
      console.log(`  oldest: ${dates[0]}`);
      console.log(`  newest: ${dates[dates.length - 1]}`);
      if (dates.length <= 30) {
        console.log("");
        for (const d of dates) console.log(`  ${d}`);
      }
    }
    return dates;
  }
}

const dailyMetricsRowSchema = z.object({
  agentId: z.string(),
  date: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  totalCostUsd: z.number(),
  costEventCount: z.number(),
  turnsComplete: z.number(),
  turnsFailed: z.number(),
  turnsInterrupted: z.number(),
  toolCalls: z.number(),
  toolErrors: z.number(),
  totalDurationMs: z.number(),
  rolledUpAt: z.number(),
});

declareCommandReturns(MetricsCommands, {
  rollup: z.object({ dates: z.array(z.string()), rowsWritten: z.number() }),
  show: z.array(dailyMetricsRowSchema),
  dates: z.array(z.string()),
});

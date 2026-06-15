/**
 * Cost Commands - inspect token/cost tracking recorded by Ravi
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, CommandAccess, Arg, Option, Returns } from "../decorators.js";
import {
  dbGetCostSummary,
  dbGetCostByAgent,
  dbGetCostForAgent,
  dbGetCostForSession,
  dbGetCostPricingCoverage,
  dbListCostEventsForPricingRecompute,
  dbGetTopSessions,
  dbUpdateCostEventPricing,
  getSession,
  resolveSession,
  type CostEventPricingRecomputeRow,
  type CostPricingCoverageRow,
} from "../../router/index.js";
import { calculateCost, loadPricingCatalog, type CostBreakdown } from "../../costs/pricing-catalog.js";

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

type PricingRecomputePayloadRow = {
  id: number;
  model: string;
  previousPricingStatus: string;
  pricingStatus: string;
  totalCost: number;
  pricingModel: string | null;
  pricingSource: string | null;
  pricingError: string | null;
};

const costWindowReturnSchema = z.object({
  requestedHours: z.string().nullable(),
  effectiveHours: z.number(),
  sinceMs: z.number(),
  untilMs: z.number(),
});

const costSummaryReturnSchema = z.object({
  total_cost: z.number(),
  total_input: z.number(),
  total_output: z.number(),
  total_cache_read: z.number(),
  total_cache_creation: z.number(),
  turns: z.number(),
  total_tokens: z.number(),
});

const costsSummaryReturnSchema = z.object({
  window: costWindowReturnSchema,
  summary: costSummaryReturnSchema,
});

const costsAgentsReturnSchema = z.object({
  window: costWindowReturnSchema,
  limit: z.number(),
  totalAgents: z.number(),
  agents: z.array(
    costSummaryReturnSchema
      .extend({
        agentId: z.string(),
        models: z.array(z.string()),
      })
      .passthrough(),
  ),
});

const costsTopSessionsReturnSchema = z.object({
  window: costWindowReturnSchema,
  limit: z.number(),
  sessions: z.array(
    costSummaryReturnSchema
      .extend({
        sessionKey: z.string(),
        sessionName: z.string().nullable(),
        name: z.string(),
        agentId: z.string(),
      })
      .passthrough(),
  ),
});

const costsAgentReturnSchema = costsSummaryReturnSchema.extend({
  agentId: z.string(),
});

const costsSessionReturnSchema = z.object({
  sessionKey: z.string(),
  sessionName: z.string().nullable(),
  agentId: z.string().nullable(),
  summary: costSummaryReturnSchema,
});

const costsPricingReturnSchema = z.object({
  window: costWindowReturnSchema,
  rows: z.array(
    z.object({
      pricingStatus: z.string(),
      model: z.string(),
      pricingModel: z.string().nullable(),
      pricingSource: z.string().nullable(),
      events: z.number(),
      totalCost: z.number(),
      totalTokens: z.number(),
      lastCreatedAt: z.number().nullable(),
    }),
  ),
  recompute: z
    .object({
      dryRun: z.boolean(),
      includePriced: z.boolean(),
      limit: z.number(),
      attempted: z.number(),
      updated: z.number(),
      priced: z.number(),
      unpriced: z.number(),
      rows: z.array(
        z.object({
          id: z.number(),
          model: z.string(),
          previousPricingStatus: z.string(),
          pricingStatus: z.string(),
          totalCost: z.number(),
          pricingModel: z.string().nullable(),
          pricingSource: z.string().nullable(),
          pricingError: z.string().nullable(),
        }),
      ),
    })
    .optional(),
});

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

function normalizeLimit(limit: string | undefined, fallback: number, max: number): number {
  const value = Number(limit ?? String(fallback));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.trunc(value), max);
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

function formatDate(value: number | null): string {
  return value ? new Date(value).toISOString() : "-";
}

function unavailableCatalogCost(model: string): CostBreakdown {
  return {
    inputCost: 0,
    outputCost: 0,
    cacheCost: 0,
    totalCost: 0,
    pricingStatus: "unpriced",
    pricingError: `No pricing catalog available while recomputing model "${model}".`,
  };
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

async function recomputePricingRows(input: {
  sinceMs: number;
  limit?: string;
  includePriced?: boolean;
  dryRun?: boolean;
}): Promise<{
  dryRun: boolean;
  includePriced: boolean;
  limit: number;
  attempted: number;
  updated: number;
  priced: number;
  unpriced: number;
  rows: PricingRecomputePayloadRow[];
}> {
  const limit = normalizeLimit(input.limit, 500, 5_000);
  const includePriced = input.includePriced === true;
  const dryRun = input.dryRun === true;
  const events = dbListCostEventsForPricingRecompute({
    sinceMs: input.sinceMs,
    limit,
    includePriced,
  }) as CostEventPricingRecomputeRow[];
  const catalog = await loadPricingCatalog();
  const rows: PricingRecomputePayloadRow[] = [];
  let priced = 0;
  let unpriced = 0;

  for (const event of events) {
    const cost = catalog
      ? await calculateCost(
          event.model,
          {
            inputTokens: event.input_tokens,
            outputTokens: event.output_tokens,
            cacheRead: event.cache_read_tokens,
            cacheCreation: event.cache_creation_tokens,
          },
          { catalog },
        )
      : unavailableCatalogCost(event.model);

    if (cost.pricingStatus === "priced") {
      priced += 1;
    } else {
      unpriced += 1;
    }

    if (!dryRun) {
      dbUpdateCostEventPricing({
        id: event.id,
        inputCostUsd: cost.inputCost,
        outputCostUsd: cost.outputCost,
        cacheCostUsd: cost.cacheCost,
        totalCostUsd: cost.totalCost,
        pricingStatus: cost.pricingStatus,
        pricingSource: cost.pricing?.source ?? null,
        pricingSourceUrl: cost.pricing?.sourceUrl ?? null,
        pricingSourceVersion: cost.pricing?.sourceVersion ?? null,
        pricingFetchedAt: cost.pricing?.fetchedAt ?? null,
        pricingModel: cost.pricing?.model ?? null,
        pricingError: cost.pricingError ?? null,
      });
    }

    rows.push({
      id: event.id,
      model: event.model,
      previousPricingStatus: event.pricing_status,
      pricingStatus: cost.pricingStatus,
      totalCost: cost.totalCost,
      pricingModel: cost.pricing?.model ?? null,
      pricingSource: cost.pricing?.source ?? null,
      pricingError: cost.pricingError ?? null,
    });
  }

  return {
    dryRun,
    includePriced,
    limit,
    attempted: events.length,
    updated: dryRun ? 0 : events.length,
    priced,
    unpriced,
    rows,
  };
}

@Group({
  name: "costs",
  description: "Inspect token and cost tracking",
  scope: "open",
})
export class CostCommands {
  @Command({ name: "summary", description: "Show total cost summary for a recent window" })
  @CommandAccess({ kind: "read", resource: "costs", action: "summary", risk: "low" })
  @Returns(costsSummaryReturnSchema)
  summary(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const summary = dbGetCostSummary(sinceMs) as CostSummary;
    const payload = {
      window: buildWindowJson(hours),
      summary: buildSummaryJson(summary),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printSummary(`Cost Summary (${hours ?? "24"}h)`, summary);
    return payload;
  }

  @Command({ name: "agents", description: "Show cost breakdown by agent" })
  @CommandAccess({ kind: "read", resource: "costs", action: "agents", risk: "low" })
  @Returns(costsAgentsReturnSchema)
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

    if (asJson) {
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
    return payload;
  }

  @Command({ name: "top-sessions", description: "Show most expensive sessions" })
  @CommandAccess({ kind: "read", resource: "costs", action: "top-sessions", risk: "low" })
  @Returns(costsTopSessionsReturnSchema)
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
    const payload = {
      window: buildWindowJson(hours),
      limit: max,
      sessions: items,
    };

    if (asJson) {
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
    return payload;
  }

  @Command({ name: "agent", description: "Show detailed cost summary for one agent" })
  @CommandAccess({ kind: "read", resource: "costs", action: "agent", risk: "low" })
  @Returns(costsAgentReturnSchema)
  agent(
    @Arg("agentId", { description: "Agent ID" }) agentId: string,
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const summary = dbGetCostForAgent(agentId, sinceMs) as CostSummary;
    const payload = {
      agentId,
      window: buildWindowJson(hours),
      summary: buildSummaryJson(summary),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printSummary(`Agent Cost (${agentId}, ${hours ?? "24"}h)`, summary);
    return payload;
  }

  @Command({ name: "session", description: "Show detailed cost summary for one session" })
  @CommandAccess({ kind: "read", resource: "costs", action: "session", risk: "low" })
  @Returns(costsSessionReturnSchema)
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

  @Command({ name: "pricing", description: "Audit pricing coverage for recent cost events" })
  @CommandAccess({ kind: "read", resource: "costs", action: "pricing", risk: "low" })
  @Returns(costsPricingReturnSchema)
  async pricing(
    @Option({ flags: "--hours <n>", description: "Time window in hours (default: 24)" }) hours?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--recompute", description: "Recompute pricing metadata for non-priced rows in the window" })
    recompute?: boolean,
    @Option({ flags: "--limit <n>", description: "Maximum rows to recompute (default: 500, max: 5000)" })
    limit?: string,
    @Option({ flags: "--include-priced", description: "Also recompute rows already marked as priced" })
    includePriced?: boolean,
    @Option({ flags: "--dry-run", description: "Preview recompute results without updating cost_events" })
    dryRun?: boolean,
  ) {
    const sinceMs = hoursToSinceMs(hours);
    const recomputeResult = recompute
      ? await recomputePricingRows({
          sinceMs,
          limit,
          includePriced,
          dryRun,
        })
      : undefined;
    const rows = dbGetCostPricingCoverage(sinceMs) as CostPricingCoverageRow[];
    const payloadRows = rows.map((row) => ({
      pricingStatus: row.pricing_status,
      model: row.model,
      pricingModel: row.pricing_model,
      pricingSource: row.pricing_source,
      events: row.events,
      totalCost: row.total_cost,
      totalTokens: row.total_input + row.total_output + row.total_cache_read + row.total_cache_creation,
      lastCreatedAt: row.last_created_at,
    }));
    const payload = {
      window: buildWindowJson(hours),
      rows: payloadRows,
      ...(recomputeResult ? { recompute: recomputeResult } : {}),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(`\nPricing Coverage (${hours ?? "24"}h)\n`);
    if (recomputeResult) {
      console.log(
        `  Recompute: ${recomputeResult.dryRun ? "dry-run, " : ""}${recomputeResult.updated}/${recomputeResult.attempted} rows updated, ${recomputeResult.priced} priced, ${recomputeResult.unpriced} unpriced`,
      );
      console.log();
    }
    console.log(
      "  STATUS     EVENTS  COST       TOKENS      MODEL                         PRICING MODEL                 SOURCE",
    );
    console.log(
      "  ---------  ------  ---------  ----------  ----------------------------  ----------------------------  ------",
    );
    for (const row of payloadRows) {
      console.log(
        `  ${row.pricingStatus.padEnd(9)}  ${String(row.events).padStart(6)}  ${formatUsd(row.totalCost).padStart(
          9,
        )}  ${formatTokens(row.totalTokens).padStart(10)}  ${row.model.slice(0, 28).padEnd(28)}  ${String(
          row.pricingModel ?? "-",
        )
          .slice(0, 28)
          .padEnd(28)}  ${row.pricingSource ?? "-"}`,
      );
    }

    const notFullyPriced = payloadRows.filter((row) => row.pricingStatus !== "priced");
    if (notFullyPriced.length > 0) {
      console.log();
      console.log("  Pricing gaps or legacy rows:");
      for (const row of notFullyPriced) {
        console.log(`  - ${row.model} (${row.events} events, last ${formatDate(row.lastCreatedAt)})`);
      }
    }
    console.log();
    return payload;
  }
}

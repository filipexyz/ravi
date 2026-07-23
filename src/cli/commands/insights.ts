import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems, parseCliListOffset } from "../pagination.js";
import {
  declareCommandReturns,
  insightCreateReturnSchema,
  insightShowReturnSchema,
  insightsListReturnSchema,
  insightsSearchReturnSchema,
} from "./operational-return-schemas.js";
import {
  dbAddInsightComment,
  dbCreateInsight,
  dbGetInsight,
  dbListInsights,
  dbSearchInsights,
} from "../../insights/index.js";
import { attachTagSlugsToAsset, canonicalAssetIdsForTag, canonicalTagSlugsForAsset } from "../../tags/index.js";
import { buildOverlayInsightsPayload } from "../../whatsapp-overlay/insights.js";
import {
  INSIGHT_CONFIDENCE,
  INSIGHT_IMPORTANCE,
  INSIGHT_KINDS,
  type InsightActor,
  type InsightConfidence,
  type InsightImportance,
  type InsightKind,
  type InsightLinkTargetType,
  type InsightListQuery,
} from "../../insights/types.js";

function requireInsightKind(value?: string): InsightKind | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase() as InsightKind;
  if (!INSIGHT_KINDS.includes(normalized)) {
    fail(`Invalid insight kind: ${value}. Use ${INSIGHT_KINDS.join("|")}.`);
  }
  return normalized;
}

function requireConfidence(value?: string): InsightConfidence | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase() as InsightConfidence;
  if (!INSIGHT_CONFIDENCE.includes(normalized)) {
    fail(`Invalid insight confidence: ${value}. Use ${INSIGHT_CONFIDENCE.join("|")}.`);
  }
  return normalized;
}

function requireImportance(value?: string): InsightImportance | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase() as InsightImportance;
  if (!INSIGHT_IMPORTANCE.includes(normalized)) {
    fail(`Invalid insight importance: ${value}. Use ${INSIGHT_IMPORTANCE.join("|")}.`);
  }
  return normalized;
}

function resolveRuntimeActor(): InsightActor {
  const ctx = getContext();
  return {
    kind: ctx?.agentId ? "agent" : "system",
    name: ctx?.sessionName ?? ctx?.agentId ?? process.env.USER ?? "cli",
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
    ...(ctx?.contextId ? { contextId: ctx.contextId } : {}),
  };
}

function resolveLinkFilter(input: { taskId?: string; sessionName?: string; agentId?: string; profileId?: string }): {
  linkType?: InsightLinkTargetType;
  linkId?: string;
} {
  if (input.taskId?.trim()) return { linkType: "task", linkId: input.taskId.trim() };
  if (input.sessionName?.trim()) return { linkType: "session", linkId: input.sessionName.trim() };
  if (input.agentId?.trim()) return { linkType: "agent", linkId: input.agentId.trim() };
  if (input.profileId?.trim()) return { linkType: "profile", linkId: input.profileId.trim() };
  return {};
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

@Group({
  name: "insights",
  description: "Operational insights with explicit lineage",
})
export class InsightCommands {
  @Command({
    name: "create",
    description: "Create a new insight with lineage captured from the current runtime context",
  })
  @CommandAccess({ kind: "mutate", resource: "insights", action: "create", risk: "medium" })
  create(
    @Arg("summary", { description: "Short actionable summary" }) summary: string,
    @Option({ flags: "--detail <text>", description: "Longer explanation or evidence" }) detail?: string,
    @Option({ flags: "--kind <kind>", description: "observation|pattern|win|problem|improvement" }) kind?: string,
    @Option({ flags: "--confidence <level>", description: "low|medium|high" }) confidence?: string,
    @Option({ flags: "--importance <level>", description: "low|normal|high" }) importance?: string,
    @Option({ flags: "--task <taskId>", description: "Link the insight to a task" }) taskId?: string,
    @Option({ flags: "--session <name>", description: "Link the insight to a session" }) sessionName?: string,
    @Option({ flags: "--agent <id>", description: "Link the insight to an agent" }) agentId?: string,
    @Option({ flags: "--artifact <path>", description: "Link the insight to one artifact path" }) artifactPath?: string,
    @Option({ flags: "--profile <id>", description: "Link the insight to a task profile" }) profileId?: string,
    @Option({ flags: "--link-type <type>", description: "Extra link type: task|session|agent|artifact|profile" })
    extraLinkType?: string,
    @Option({ flags: "--link-id <value>", description: "Extra link target ID/path" }) extraLinkId?: string,
    @Option({ flags: "--comment <text>", description: "Optional initial comment to append after creation" })
    comment?: string,
    @Option({ flags: "--auto-context", description: "Auto-link the current runtime session and agent when present" })
    autoContext?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--tag <tag...>", description: "Canonical tags; can be repeated or comma-separated" })
    tags?: string[],
  ) {
    const author = resolveRuntimeActor();
    const ctx = getContext();
    const links: Array<{ targetType: InsightLinkTargetType; targetId: string }> = [];

    if (taskId?.trim()) links.push({ targetType: "task", targetId: taskId.trim() });
    if (sessionName?.trim()) links.push({ targetType: "session", targetId: sessionName.trim() });
    if (agentId?.trim()) links.push({ targetType: "agent", targetId: agentId.trim() });
    if (artifactPath?.trim()) links.push({ targetType: "artifact", targetId: artifactPath.trim() });
    if (profileId?.trim()) links.push({ targetType: "profile", targetId: profileId.trim() });

    if (extraLinkType?.trim() || extraLinkId?.trim()) {
      const normalizedType = extraLinkType?.trim() as InsightLinkTargetType | undefined;
      if (!normalizedType || !["task", "session", "agent", "artifact", "profile"].includes(normalizedType)) {
        fail("Invalid --link-type. Use task|session|agent|artifact|profile.");
      }
      if (!extraLinkId?.trim()) {
        fail("--link-id is required when --link-type is set.");
      }
      links.push({ targetType: normalizedType, targetId: extraLinkId.trim() });
    }

    if (autoContext) {
      if (ctx?.sessionName) {
        links.push({ targetType: "session", targetId: ctx.sessionName });
      }
      if (ctx?.agentId) {
        links.push({ targetType: "agent", targetId: ctx.agentId });
      }
    }

    const created = dbCreateInsight({
      summary: summary.trim(),
      ...(detail?.trim() ? { detail: detail.trim() } : {}),
      ...(requireInsightKind(kind) ? { kind: requireInsightKind(kind) } : {}),
      ...(requireConfidence(confidence) ? { confidence: requireConfidence(confidence) } : {}),
      ...(requireImportance(importance) ? { importance: requireImportance(importance) } : {}),
      author,
      origin: {
        kind: ctx?.contextId ? "runtime-context" : "manual",
        ...(ctx?.contextId ? { contextId: ctx.contextId } : {}),
        ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
        ...(ctx?.sessionName ? { sessionName: ctx.sessionName } : {}),
        ...(taskId?.trim() ? { taskId: taskId.trim() } : {}),
      },
      links,
    });

    const createdComment = comment?.trim()
      ? dbAddInsightComment({
          insightId: created.id,
          body: comment.trim(),
          author,
        })
      : undefined;
    const tagBindings = attachTagSlugsToAsset({
      assetType: "insight",
      assetId: created.id,
      tags: parseStringList(tags),
      source: "insights.cli",
      createdBy: author.name,
    });
    const insight = createdComment ? (dbGetInsight(created.id) ?? created) : created;

    const payload = {
      success: true as const,
      insight,
      ...(createdComment ? { comment: createdComment } : {}),
      tags: tagBindings.map((binding) => binding.tagSlug),
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Insight created: ${created.id}`);
      console.log(`  Kind:       ${created.kind}`);
      console.log(`  Confidence: ${created.confidence}`);
      console.log(`  Importance: ${created.importance}`);
      console.log(`  Summary:    ${created.summary}`);
    }
    return payload;
  }

  @Command({ name: "list", description: "List recent insights with optional filters" })
  @CommandAccess({ kind: "read", resource: "insights", action: "list", risk: "low" })
  list(
    @Option({ flags: "--kind <kind>", description: "observation|pattern|win|problem|improvement" }) kind?: string,
    @Option({ flags: "--confidence <level>", description: "low|medium|high" }) confidence?: string,
    @Option({ flags: "--importance <level>", description: "low|normal|high" }) importance?: string,
    @Option({ flags: "--task <taskId>", description: "Filter by linked task" }) taskId?: string,
    @Option({ flags: "--session <name>", description: "Filter by linked session" }) sessionName?: string,
    @Option({ flags: "--agent <id>", description: "Filter by linked agent" }) agentId?: string,
    @Option({ flags: "--profile <id>", description: "Filter by linked profile" }) profileId?: string,
    @Option({ flags: "--tag <tag>", description: "Filter by canonical tag" }) tag?: string,
    @Option({ flags: "--query <text>", description: "Free-text search over summaries/details/comments" })
    query?: string,
    @Option({ flags: "--limit <n>", description: "Result limit", defaultValue: "20" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--rich",
      description:
        "Return rich projection with stats, decorated lineage (task/session/agent refs), and per-link metadata. Honors --limit only; other filters are ignored.",
    })
    rich?: boolean,
    @Option({ flags: "--offset <n>", description: "Number of matching insights to skip (default: 0)" }) offset?: string,
  ) {
    const parsedLimit = Number.parseInt(limit ?? "20", 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      fail(`Invalid --limit: ${limit}`);
    }
    const pageOffset = parseCliListOffset(offset);

    if (rich) {
      const payload = buildOverlayInsightsPayload({ limit: parsedLimit });
      printJson(payload);
      return payload;
    }

    const linkFilter = resolveLinkFilter({ taskId, sessionName, agentId, profileId });
    const insightIds = canonicalAssetIdsForTag("insight", tag);
    const queryInput: InsightListQuery = {
      ...(requireInsightKind(kind) ? { kind: requireInsightKind(kind) } : {}),
      ...(requireConfidence(confidence) ? { confidence: requireConfidence(confidence) } : {}),
      ...(requireImportance(importance) ? { importance: requireImportance(importance) } : {}),
      ...(query?.trim() ? { text: query.trim() } : {}),
      ...(linkFilter.linkType && linkFilter.linkId ? linkFilter : {}),
      ...(insightIds ? { insightIds } : {}),
      limit: Math.min(parsedLimit + pageOffset, 200),
    };
    const fetchedItems = dbListInsights(queryInput);
    const page = paginateCliItems(fetchedItems, { limit: parsedLimit, offset: pageOffset }, { defaultLimit: 20 });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "insights", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--kind",
        kind,
        "--confidence",
        confidence,
        "--importance",
        importance,
        "--task",
        taskId,
        "--session",
        sessionName,
        "--agent",
        agentId,
        "--profile",
        profileId,
        "--tag",
        tag?.trim() || null,
        "--query",
        query?.trim() || null,
      ],
    });
    const payload = {
      count: page.items.length,
      total: page.total,
      pagination,
      query: { ...queryInput, tag: tag?.trim() || undefined },
      items: page.items,
      insights: page.items,
    };

    if (asJson) {
      printJson(payload);
    } else if (page.items.length === 0) {
      console.log("No insights found.");
    } else {
      console.log(
        `\nInsights (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset})\n`,
      );
      console.log("  ID              KIND         CONF.   IMP.    UPDATED      SUMMARY");
      console.log("  --------------  -----------  ------  ------  ----------  --------------------------------");
      for (const item of page.items) {
        console.log(
          `  ${item.id.padEnd(14)}  ${item.kind.padEnd(11)}  ${item.confidence.padEnd(6)}  ${item.importance.padEnd(6)}  ${formatTimestamp(item.updatedAt).padEnd(10)}  ${item.summary.slice(0, 32)}`,
        );
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one insight with lineage and comments" })
  @CommandAccess({ kind: "read", resource: "insights", action: "show", risk: "low" })
  show(
    @Arg("id", { description: "Insight ID" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const insight = dbGetInsight(id.trim());
    if (!insight) {
      fail(`Insight not found: ${id}`);
    }

    const tags = canonicalTagSlugsForAsset("insight", insight.id);
    const payload = { insight, tags };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\nInsight: ${insight.id}`);
      console.log(`  Kind:       ${insight.kind}`);
      console.log(`  Confidence: ${insight.confidence}`);
      console.log(`  Importance: ${insight.importance}`);
      console.log(`  Author:     ${insight.author.name}`);
      console.log(`  Origin:     ${insight.origin.kind}`);
      console.log(`  Created:    ${formatTimestamp(insight.createdAt)}`);
      console.log(`\nSummary:\n${insight.summary}`);
      if (insight.detail) {
        console.log(`\nDetail:\n${insight.detail}`);
      }
      if (insight.links.length > 0) {
        console.log("\nLinks:");
        for (const link of insight.links) {
          console.log(`  - ${link.targetType}: ${link.targetId}`);
        }
      }
      if (tags.length > 0) {
        console.log(`\nTags: ${tags.join(", ")}`);
      }
      if (insight.comments.length > 0) {
        console.log("\nComments:");
        for (const comment of insight.comments) {
          console.log(`  - ${comment.author.name}: ${comment.body}`);
        }
      }
    }
    return payload;
  }

  @Command({ name: "search", description: "Search insights by free text" })
  @CommandAccess({ kind: "read", resource: "insights", action: "search", risk: "low" })
  search(
    @Arg("text", { description: "Search text" }) text: string,
    @Option({ flags: "--limit <n>", description: "Result limit", defaultValue: "20" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsedLimit = Number.parseInt(limit ?? "20", 10);
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      fail(`Invalid --limit: ${limit}`);
    }

    const items = dbSearchInsights(text.trim(), { limit: parsedLimit });
    const payload = {
      count: items.length,
      query: {
        text: text.trim(),
        limit: parsedLimit,
      },
      insights: items,
    };

    if (asJson) {
      printJson(payload);
    } else if (items.length === 0) {
      console.log("No insights found.");
    } else {
      console.log(`\nInsights (${items.length})\n`);
      console.log("  ID              UPDATED      SUMMARY");
      console.log("  --------------  ----------  --------------------------------");
      for (const item of items) {
        console.log(
          `  ${item.id.padEnd(14)}  ${formatTimestamp(item.updatedAt).padEnd(10)}  ${item.summary.slice(0, 32)}`,
        );
      }
    }
    return payload;
  }
}

declareCommandReturns(InsightCommands, {
  create: insightCreateReturnSchema,
  list: insightsListReturnSchema,
  search: insightsSearchReturnSchema,
  show: insightShowReturnSchema,
});

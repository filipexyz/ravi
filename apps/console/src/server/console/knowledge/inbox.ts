import { and, eq } from "drizzle-orm";

import { recordAgentInboxItem, type AgentInboxDbExecutor } from "@/server/console/agent-inbox";
import { db, schema } from "@/server/db";

// Knowledge inbox items carry ids only: the title is a constant, the summary is
// null and the payload names the proposal or route. The daemon reads the rest
// through the CLI API, which checks access again.

const CATEGORY = "knowledge";

/** `knowledge.gap.answered`, targeted at the installation that sent the gap. `origin` builds the card URL. */
export async function recordKnowledgeGapAnswered(
  input: { proposalId: string; origin: string },
  executor?: AgentInboxDbExecutor,
): Promise<void> {
  const reader = executor ?? db;
  const [proposal] = await reader
    .select({
      id: schema.knowledgeProposals.id,
      organizationId: schema.knowledgeProposals.organizationId,
      projectId: schema.knowledgeProposals.projectId,
      kind: schema.knowledgeProposals.kind,
      status: schema.knowledgeProposals.status,
      localInstallationId: schema.knowledgeProposals.localInstallationId,
      resultJson: schema.knowledgeProposals.resultJson,
    })
    .from(schema.knowledgeProposals)
    .where(and(eq(schema.knowledgeProposals.id, input.proposalId), eq(schema.knowledgeProposals.kind, "gap")))
    .limit(1);
  // Nobody to tell: the installation was removed, or the gap is not answered.
  if (!proposal?.localInstallationId || proposal.status !== "approved") return;

  await recordAgentInboxItem(
    buildKnowledgeGapAnsweredItem({
      proposalId: proposal.id,
      organizationId: proposal.organizationId,
      projectId: proposal.projectId,
      localInstallationId: proposal.localInstallationId,
      faqUrl: faqUrlFromResult(proposal.resultJson),
      origin: input.origin,
    }),
    executor,
  );
}

/** `knowledge.marks.changed`, for the whole organization: daemons re-sync their mirror. */
export async function recordKnowledgeMarksChanged(
  input: { organizationId: string; routeId: string; action: string },
  executor?: AgentInboxDbExecutor,
): Promise<void> {
  await recordAgentInboxItem(buildKnowledgeMarksChangedItem({ ...input, now: new Date() }), executor);
}

export function buildKnowledgeGapAnsweredItem(input: {
  proposalId: string;
  organizationId: string;
  projectId: string | null;
  localInstallationId: string;
  faqUrl: string | null;
  origin: string;
}) {
  return {
    actorType: "system",
    category: CATEGORY,
    dedupeKey: `knowledge:gap:${input.proposalId}:answered`,
    eventType: "knowledge.gap.answered",
    linksJson: {
      cardUrl: knowledgeProposalCardUrl(input.origin, input.proposalId),
      faqUrl: input.faqUrl,
    },
    organizationId: input.organizationId,
    payloadJson: { proposalId: input.proposalId, projectId: input.projectId },
    projectId: input.projectId,
    sensitivity: "metadata",
    severity: "success",
    sourceId: input.proposalId,
    sourceType: "knowledge_proposal",
    summary: null,
    targetId: input.localInstallationId,
    targetType: "local_installation",
    title: "Knowledge gap answered",
  } satisfies typeof schema.agentInboxItems.$inferInsert;
}

export function buildKnowledgeMarksChangedItem(input: { organizationId: string; routeId: string; action: string; now: Date }) {
  return {
    actorType: "system",
    category: CATEGORY,
    dedupeKey: `knowledge:marks:${input.routeId}:${Math.floor(input.now.getTime() / 1000)}`,
    eventType: "knowledge.marks.changed",
    linksJson: {},
    organizationId: input.organizationId,
    payloadJson: { routeId: input.routeId, action: input.action },
    projectId: null,
    sensitivity: "metadata",
    severity: "info",
    sourceId: input.routeId,
    sourceType: "page_route",
    summary: null,
    targetId: input.organizationId,
    targetType: "organization",
    title: "Knowledge marks changed",
    occurredAt: input.now,
  } satisfies typeof schema.agentInboxItems.$inferInsert;
}

export function knowledgeProposalCardUrl(origin: string, proposalId: string) {
  return `${origin.replace(/\/+$/, "")}/k/${proposalId}`;
}

export function knowledgeRouteCardUrl(origin: string, routeId: string) {
  return `${origin.replace(/\/+$/, "")}/k/routes/${routeId}`;
}

function faqUrlFromResult(result: Record<string, unknown>) {
  const url = typeof result.url === "string" ? result.url : null;
  const anchor = typeof result.anchor === "string" ? result.anchor : null;
  if (!url) return null;
  return anchor ? `${url}#${anchor}` : url;
}

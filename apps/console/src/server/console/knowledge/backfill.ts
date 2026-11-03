import { and, eq, gt, isNotNull } from "drizzle-orm";

import { db, schema } from "@/server/db";

import { enqueueMeetingKnowledgeCapture } from "./producers/meeting";
import { enqueueReleaseCaptures } from "./producers/page";
import { scheduleKnowledgeDrain } from "./schedule";

// The first search of an organization starts this (K-C2, in `after()`): what
// was recorded or published before Knowledge was on gets captured. Meetings
// only within the vendor's 7-day window; pages from every active release.

const MEETING_WINDOW_MS = 7 * 24 * 3600 * 1000;

export async function startKnowledgeBackfill(
  input: { organizationId: string; requestId: string },
  deps: { now?: () => Date; drain?: (requestId: string) => void } = {},
): Promise<{ meetings: number; pages: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const meetings = await db
    .select({ id: schema.meetingBots.id, projectId: schema.meetingBots.projectId, title: schema.meetingBots.title })
    .from(schema.meetingBots)
    .where(
      and(
        eq(schema.meetingBots.organizationId, input.organizationId),
        eq(schema.meetingBots.status, "done"),
        isNotNull(schema.meetingBots.providerBotId),
        isNotNull(schema.meetingBots.projectId),
        gt(schema.meetingBots.createdAt, new Date(now.getTime() - MEETING_WINDOW_MS)),
      ),
    );
  let meetingCount = 0;
  for (const meeting of meetings) {
    if (!meeting.projectId) continue;
    const queued = await enqueueMeetingKnowledgeCapture({
      organizationId: input.organizationId,
      projectId: meeting.projectId,
      meetingId: meeting.id,
      title: meeting.title,
      trigger: "meeting_backfill",
      requestId: input.requestId,
    });
    if (queued.created) meetingCount += 1;
  }

  const sites = await db
    .select({
      id: schema.pageSites.id,
      organizationId: schema.pageSites.organizationId,
      projectId: schema.pageSites.projectId,
      defaultHostname: schema.pageSites.defaultHostname,
      activeReleaseId: schema.pageSites.activeReleaseId,
      status: schema.pageSites.status,
    })
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.organizationId, input.organizationId),
        eq(schema.pageSites.status, "active"),
        isNotNull(schema.pageSites.activeReleaseId),
      ),
    );
  let pageCount = 0;
  for (const site of sites) {
    if (!site.activeReleaseId) continue;
    const routes = await enqueueReleaseCaptures({ site, releaseId: site.activeReleaseId, trigger: "page_backfill", requestId: input.requestId });
    pageCount += routes.length;
  }

  if (meetingCount + pageCount > 0) (deps.drain ?? scheduleKnowledgeDrain)(input.requestId);
  return { meetings: meetingCount, pages: pageCount };
}

import { usageEventTypes, usageMetricKeys, type UsageEventRecordInput } from "@/server/console/billing/usage-metering";
import type { JsonRecord } from "@/server/db/schema";

import { estimateMeetingCostUsd, MEETINGS_PRICE_VERSION } from "./limits";

export const MEETINGS_USAGE_SOURCE = "meetings";

export type MeetingRecordingUsage = {
  organizationId: string;
  projectId: string | null;
  meetingBotId: string;
  provider: string;
  platform: string;
  recordingSeconds: number;
  outcome: "done" | "failed";
  endedAt: Date;
  requestId: string;
};

/** One bot, once: a count carrying the estimated cost, and the recorded seconds. */
export function buildMeetingRecordingUsageEvents(usage: MeetingRecordingUsage): UsageEventRecordInput[] {
  const cost = estimateMeetingCostUsd(usage.recordingSeconds);
  const dimensionsJson: JsonRecord = {
    service: "meetings",
    object: "meeting_bot",
    meetingBotId: usage.meetingBotId,
    platform: usage.platform,
    outcome: usage.outcome,
  };
  const event = (metricKey: string, quantity: number, unit: string, measurementsJson: JsonRecord = {}) =>
    ({
      organizationId: usage.organizationId,
      projectId: usage.projectId,
      siteId: null,
      releaseId: null,
      routeId: null,
      artifactId: null,
      artifactVersionId: null,
      assetId: null,
      publishId: null,
      source: MEETINGS_USAGE_SOURCE,
      eventType: usageEventTypes.meetingsRecordingClosed,
      metricKey,
      quantity: decimal(quantity),
      unit,
      dimensionsJson,
      measurementsJson,
      evidenceJson: {},
      metadataJson: { provider: usage.provider },
      idempotencyKey: `${usageEventTypes.meetingsRecordingClosed}:${usage.meetingBotId}:${metricKey}`,
      requestId: usage.requestId,
      occurredAt: usage.endedAt,
    }) satisfies UsageEventRecordInput;

  return [
    event(usageMetricKeys.meetingsBots, 1, "count", {
      estimatedCostUsd: cost,
      priceVersion: MEETINGS_PRICE_VERSION,
    }),
    event(usageMetricKeys.meetingsRecordingSeconds, usage.recordingSeconds, "seconds"),
  ];
}

function decimal(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return (Math.round(value * 1000) / 1000).toString();
}

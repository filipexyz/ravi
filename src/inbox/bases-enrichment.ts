// Local enrichment of Console `bases.row.*` inbox items. Console payloads
// carry ids only (no values); the local runner reads the row through the Bases
// CLI API with the installation's own credentials, so triggers can filter and
// key sessions on row values (e.g. a forum comment's `topic_id`). Transport
// only: Console authorization decides what the read returns.

import type { BaseRowWriteResponse } from "../bases/schemas.js";
import type { InboxNatsPayload } from "./types.js";

const BASES_ROW_EVENT_TYPES = new Set([
  "bases.row.created",
  "bases.row.updated",
  "bases.row.restored",
  "bases.row.archived",
]);

export type BasesRowReader = (input: {
  projectId: string;
  baseId: string;
  rowId: string;
  includeArchived: boolean;
}) => Promise<BaseRowWriteResponse>;

export function isBasesRowInboxEvent(eventType: string): boolean {
  return BASES_ROW_EVENT_TYPES.has(eventType);
}

/**
 * Adds `payload.row = { rowId, version, values, archivedAt }` (no body) to a
 * `bases.row.*` item. When the read fails the item keeps its metadata-only
 * payload plus `payload.rowEnrichment = { status: "failed", code }`.
 */
export async function enrichBasesRowPayload(
  natsPayload: InboxNatsPayload,
  readRow: BasesRowReader,
): Promise<InboxNatsPayload> {
  if (!isBasesRowInboxEvent(natsPayload.eventType)) return natsPayload;
  const payload = natsPayload.payload ?? {};
  const envelopeProjectId = text(natsPayload.project?.id);
  const payloadProjectId = text(payload.projectId);
  const projectId = payloadProjectId ?? envelopeProjectId;
  const baseId = text(payload.baseId);
  const rowId = text(payload.rowId);
  if (!projectId || !baseId || !rowId) {
    return withRowEnrichment(natsPayload, { status: "failed", code: "row_ref_missing" });
  }
  // Only dereference rows of the project the item was delivered for.
  if (payloadProjectId && envelopeProjectId && payloadProjectId !== envelopeProjectId) {
    return withRowEnrichment(natsPayload, { status: "failed", code: "row_ref_mismatch" });
  }

  try {
    const { row } = await readRow({
      projectId,
      baseId,
      rowId,
      includeArchived: natsPayload.eventType === "bases.row.archived",
    });
    return {
      ...natsPayload,
      payload: {
        ...payload,
        row: { rowId: row.rowId, version: row.version, values: row.values, archivedAt: row.archivedAt ?? null },
        rowEnrichment: { status: "ok" },
      },
    };
  } catch (error) {
    return withRowEnrichment(natsPayload, { status: "failed", code: errorCode(error) });
  }
}

function withRowEnrichment(natsPayload: InboxNatsPayload, rowEnrichment: { status: "failed"; code: string }) {
  return { ...natsPayload, payload: { ...(natsPayload.payload ?? {}), rowEnrichment } };
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "row_read_failed";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

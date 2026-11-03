// Activity of a base (SPEC "Activity"): its `bases.*` audit events, newest
// first, for managers. Events target the base itself or one of its
// properties, views, charts, or subscriptions (`metadata.baseId`). Row
// changes live in each row's history, not here.

import { sql } from "drizzle-orm";

import { colorFor, markFor } from "@/features/console/types";
import { db } from "@/server/db";
import { BASES_LIMITS } from "@/shared/bases/limits";
import type { BaseActivityEvent, BaseActivityResponse } from "@/shared/bases/types";
import { isBaseUuid } from "@/shared/bases/values";

import { forbidden, validationFailed } from "./errors";
import { executeRows } from "./repository";
import type { BaseScope } from "./scope";

const CHILD_TARGET_TYPES = ["base_property", "base_view", "base_chart", "base_subscription"] as const;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type ActivityCursor = { t: string; id: string };

function encodeCursor(cursor: ActivityCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Keyset cursor `{ t, id }`: the exact (microsecond) `created_at` and id of the last event of the page. */
export function decodeActivityCursor(raw: string | null): ActivityCursor | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<ActivityCursor>;
    if (typeof parsed.t === "string" && TIMESTAMP_PATTERN.test(parsed.t) && typeof parsed.id === "string" && isBaseUuid(parsed.id)) {
      return { t: parsed.t, id: parsed.id.toLowerCase() };
    }
  } catch {
    // fall through
  }
  validationFailed({ cursor: "The cursor is invalid." });
}

function actorLabel(actorType: string, actorId: string | null) {
  if (actorType === "system") return "system";
  if (actorType === "anonymous") return "anonymous";
  return actorId ?? actorType;
}

type ActivityRow = {
  id: string;
  created_at: string;
  action: string;
  target_type: string;
  target_id: string | null;
  actor_type: string;
  actor_id: string | null;
  note: string | null;
};

export async function listBaseActivity(scope: BaseScope, searchParams: URLSearchParams): Promise<BaseActivityResponse> {
  if (!scope.access.manage) forbidden("Base activity needs project write access.");
  const cursor = decodeActivityCursor(searchParams.get("cursor"));
  const limit = BASES_LIMITS.activityPageSize;
  const baseId = scope.base.id;
  const after = cursor ? sql`AND (e.created_at, e.id) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)` : sql``;
  const rows = await executeRows<ActivityRow>(
    db,
    sql`SELECT e.id::text AS id,
        to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        e.action, e.target_type, e.target_id, e.actor_type::text AS actor_type, e.actor_id,
        CASE WHEN jsonb_typeof(e.metadata_json -> 'note') = 'string' THEN e.metadata_json ->> 'note' END AS note
      FROM audit_events AS e
      WHERE e.organization_id = ${scope.base.organizationId}::uuid
        AND e.project_id = ${scope.base.projectId}::uuid
        AND e.action LIKE 'bases.%'
        AND (
          (e.target_type = 'base' AND e.target_id = ${baseId})
          OR (e.target_type IN (${sql.join(
            CHILD_TARGET_TYPES.map((type) => sql`${type}`),
            sql`, `,
          )}) AND e.metadata_json ->> 'baseId' = ${baseId})
        )
        ${after}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${limit + 1}`,
  );
  const page = rows.slice(0, limit);
  const events = page.map(
    (row): BaseActivityEvent => ({
      id: row.id,
      t: Date.parse(row.created_at),
      type: row.action,
      project: scope.project.slug,
      target: row.target_id ?? row.target_type,
      actor: actorLabel(row.actor_type, row.actor_id),
      actorMark: markFor(row.actor_id ?? row.actor_type),
      color: colorFor(row.actor_id ?? row.actor_type),
      ...(row.note ? { note: row.note } : {}),
    }),
  );
  const last = page[page.length - 1];
  return { events, nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at, id: last.id }) : null };
}

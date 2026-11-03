import { sql, type SQL } from "drizzle-orm";

import { db } from "@/server/db";

// Usage metrics computed from what the Console already records: audit events,
// Bases row writes and completed Pages publishes (people), and the Pages
// Worker's served requests (traffic). A person is a Console user acting as
// `user` (Console, Pages) or `cli` (the CLI and the agents running on it).
// Spec: `.ravi/specs/console/usage-metrics/SPEC.md`.

export const METRICS_TIMEZONE = "America/Sao_Paulo";
export const METRICS_PEOPLE_WINDOW_DAYS = 90;

export type MetricsArea = "Pages" | "Bases" | "Knowledge" | "Meet" | "Biblioteca" | "Mail" | "Conectores" | "Convites" | "CLI" | "Outros";
export const METRICS_AREAS: readonly MetricsArea[] = ["Pages", "Bases", "Knowledge", "Meet", "Biblioteca", "Mail", "Conectores", "Convites", "CLI", "Outros"];

export type DailyMetrics = {
  /** Local date (`METRICS_TIMEZONE`), `YYYY-MM-DD`. */
  day: string;
  activePeople: number;
  activePeople7d: number;
  activePeople30d: number;
  activeOrgs7d: number;
  newPeople: number;
  publishers7d: number;
  publishes: number;
  readers7d: number;
  publicRequests: number;
  privateRequests: number;
  visitedSites: number;
  activeInstallations7d: number;
};

export type PersonUsage = {
  userId: string;
  name: string;
  email: string;
  organizations: string[];
  joinedAt: string;
  lastActiveAt: string;
  actions30d: number;
  publishes30d: number;
  pageOpens30d: number;
  usesCli30d: boolean;
  active7d: boolean;
  areas30d: MetricsArea[];
  staff: boolean;
};

export type MetricsFilter = {
  /** Organizations left out of every count (internal or test orgs). */
  excludeOrgIds: readonly string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses `RAVI_METRICS_EXCLUDE_ORG_IDS` (comma-separated uuids); anything else is dropped. */
export function parseExcludedOrgIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => UUID.test(part));
}

/** Local date of `at` in the metrics timezone. */
export function localDay(at: Date, timeZone = METRICS_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** `day` plus `delta` days, on the calendar. */
export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function uuidArray(ids: readonly string[]): SQL {
  if (ids.length === 0) return sql`array[]::uuid[]`;
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
}

/**
 * Who did what, with the area of the action: audit events, Bases row writes,
 * and completed publishes by people (`user` or `cli`) in [from, to).
 */
function activitySql(input: { from: SQL; to: SQL; excludeOrgIds: readonly string[] }): SQL {
  const excluded = uuidArray(input.excludeOrgIds);
  return sql`
    select u.id as user_id, x.organization_id, x.at, x.kind, x.area, x.via
    from (
      select a.actor_id, a.organization_id, a.created_at as at,
        case when a.action = 'pages.private_route.allowed' then 'read' else 'action' end as kind,
        case
          when a.action like 'pages.%' or a.action like 'page\\_%' then 'Pages'
          when a.action like 'bases.%' then 'Bases'
          when a.action like 'knowledge%' then 'Knowledge'
          when a.action like 'meetings.%' then 'Meet'
          when a.action like 'library%' then 'Biblioteca'
          when a.action like 'mail%' then 'Mail'
          when a.action like 'connector%' then 'Conectores'
          when a.action like 'organization\\_invite%' or a.action like 'access\\_%' then 'Convites'
          when a.action like 'cli\\_session%' then 'CLI'
          else 'Outros'
        end as area,
        a.actor_type::text as via
      from audit_events a
      where a.actor_type in ('user', 'cli') and a.created_at >= ${input.from} and a.created_at < ${input.to}
      union all
      select l.actor_id, l.organization_id, l.created_at, 'action', 'Bases', l.actor_type::text
      from base_row_ledger l
      where l.actor_type in ('user', 'cli') and l.created_at >= ${input.from} and l.created_at < ${input.to}
      union all
      select p.created_by_actor_id, p.organization_id, coalesce(p.completed_at, p.created_at), 'publish', 'Pages', p.created_by_actor_type::text
      from page_publishes p
      where p.status = 'completed' and p.created_by_actor_type in ('user', 'cli')
        and coalesce(p.completed_at, p.created_at) >= ${input.from} and coalesce(p.completed_at, p.created_at) < ${input.to}
    ) x
    join users u on u.id::text = lower(x.actor_id)
    where x.organization_id is null or not (x.organization_id = any(${excluded}))
  `;
}

type DailyRow = {
  day: string;
  active_people: number | string;
  active_people_7d: number | string;
  active_people_30d: number | string;
  active_orgs_7d: number | string;
  new_people: number | string;
  publishers_7d: number | string;
  publishes: number | string;
  readers_7d: number | string;
  public_requests: number | string;
  private_requests: number | string;
  visited_sites: number | string;
  active_installations_7d: number | string;
};

/**
 * One row per local day in [fromDay, toDay]. Rolling windows end with the
 * day. The Ravi team (platform operators) is left out of the people counts.
 */
export async function computeDailyMetrics(input: MetricsFilter & { fromDay: string; toDay: string; timeZone?: string }): Promise<DailyMetrics[]> {
  const tz = input.timeZone ?? METRICS_TIMEZONE;
  const windowFrom = sql`((${shiftDay(input.fromDay, -30)})::date::timestamp at time zone ${tz})`;
  const windowTo = sql`((${shiftDay(input.toDay, 1)})::date::timestamp at time zone ${tz})`;
  const excluded = uuidArray(input.excludeOrgIds);
  const result = await db.execute(sql`
    with days as (
      select d::date as day,
        (d::date::timestamp at time zone ${tz}) as day_start,
        ((d::date + 1)::timestamp at time zone ${tz}) as day_end
      from generate_series(${input.fromDay}::date, ${input.toDay}::date, interval '1 day') d
    ),
    activity as materialized (
      select a.* from (${activitySql({ from: windowFrom, to: windowTo, excludeOrgIds: input.excludeOrgIds })}) a
      where not exists (select 1 from platform_operators po where po.user_id = a.user_id)
    ),
    traffic as materialized (
      select e.occurred_at, e.metric_key, e.quantity, e.site_id
      from usage_events e
      where e.event_type = 'pages.request_served'
        and e.occurred_at >= (${input.fromDay}::date::timestamp at time zone ${tz})
        and e.occurred_at < ${windowTo}
        and not (e.organization_id = any(${excluded}))
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
      (select count(distinct a.user_id) from activity a where a.at >= d.day_start and a.at < d.day_end) as active_people,
      (select count(distinct a.user_id) from activity a where a.at >= d.day_end - interval '7 days' and a.at < d.day_end) as active_people_7d,
      (select count(distinct a.user_id) from activity a where a.at >= d.day_end - interval '30 days' and a.at < d.day_end) as active_people_30d,
      (select count(distinct a.organization_id) from activity a where a.at >= d.day_end - interval '7 days' and a.at < d.day_end) as active_orgs_7d,
      (select count(*) from users u
        where u.created_at >= d.day_start and u.created_at < d.day_end
          and not exists (select 1 from platform_operators po where po.user_id = u.id)) as new_people,
      (select count(distinct a.user_id) from activity a where a.kind = 'publish' and a.at >= d.day_end - interval '7 days' and a.at < d.day_end) as publishers_7d,
      (select count(*) from activity a where a.kind = 'publish' and a.at >= d.day_start and a.at < d.day_end) as publishes,
      (select count(distinct a.user_id) from activity a where a.kind = 'read' and a.at >= d.day_end - interval '7 days' and a.at < d.day_end) as readers_7d,
      (select coalesce(sum(t.quantity), 0) from traffic t where t.metric_key = 'pages.requests.public' and t.occurred_at >= d.day_start and t.occurred_at < d.day_end) as public_requests,
      (select coalesce(sum(t.quantity), 0) from traffic t where t.metric_key = 'pages.requests.private' and t.occurred_at >= d.day_start and t.occurred_at < d.day_end) as private_requests,
      (select count(distinct t.site_id) from traffic t where t.occurred_at >= d.day_start and t.occurred_at < d.day_end) as visited_sites,
      (select count(*) from local_installations li
        where li.revoked_at is null and li.first_seen_at < d.day_end and li.last_seen_at >= d.day_end - interval '7 days'
          and not (li.organization_id = any(${excluded}))) as active_installations_7d
    from days d
    order by d.day
  `);
  return (result as unknown as DailyRow[]).map((row) => ({
    day: row.day,
    activePeople: Number(row.active_people),
    activePeople7d: Number(row.active_people_7d),
    activePeople30d: Number(row.active_people_30d),
    activeOrgs7d: Number(row.active_orgs_7d),
    newPeople: Number(row.new_people),
    publishers7d: Number(row.publishers_7d),
    publishes: Number(row.publishes),
    readers7d: Number(row.readers_7d),
    publicRequests: Number(row.public_requests),
    privateRequests: Number(row.private_requests),
    visitedSites: Number(row.visited_sites),
    activeInstallations7d: Number(row.active_installations_7d),
  }));
}

type PersonRow = {
  user_id: string;
  display_name: string | null;
  primary_email: string;
  joined_at: Date | string;
  last_active_at: Date | string;
  actions_30d: number | string;
  publishes_30d: number | string;
  page_opens_30d: number | string;
  uses_cli_30d: boolean | null;
  active_7d: boolean | null;
  areas_30d: string[] | null;
  organizations: string[] | null;
  staff: boolean;
};

/** Everyone with activity in the last `METRICS_PEOPLE_WINDOW_DAYS` days, most recent first. */
export async function computePeopleUsage(input: MetricsFilter & { now: Date }): Promise<PersonUsage[]> {
  const now = sql`${input.now.toISOString()}::timestamptz`;
  const from = sql`(${now} - ${sql.raw(`interval '${METRICS_PEOPLE_WINDOW_DAYS} days'`)})`;
  const result = await db.execute(sql`
    with activity as materialized (${activitySql({ from, to: now, excludeOrgIds: input.excludeOrgIds })})
    select u.id as user_id, u.display_name, u.primary_email, u.created_at as joined_at,
      max(a.at) as last_active_at,
      count(*) filter (where a.kind <> 'read' and a.at >= ${now} - interval '30 days') as actions_30d,
      count(*) filter (where a.kind = 'publish' and a.at >= ${now} - interval '30 days') as publishes_30d,
      count(*) filter (where a.kind = 'read' and a.at >= ${now} - interval '30 days') as page_opens_30d,
      coalesce(bool_or(a.via = 'cli' and a.at >= ${now} - interval '30 days'), false) as uses_cli_30d,
      coalesce(bool_or(a.at >= ${now} - interval '7 days'), false) as active_7d,
      array_remove(array_agg(distinct case when a.at >= ${now} - interval '30 days' then a.area end), null) as areas_30d,
      (select array_agg(o.name order by o.name) from organization_memberships m
        join organizations o on o.id = m.organization_id
        where m.user_id = u.id and m.status = 'active' and o.status = 'active') as organizations,
      exists (select 1 from platform_operators po where po.user_id = u.id) as staff
    from activity a
    join users u on u.id = a.user_id
    group by u.id
    order by max(a.at) desc
  `);
  return (result as unknown as PersonRow[]).map((row) => ({
    userId: row.user_id,
    name: row.display_name?.trim() || row.primary_email,
    email: row.primary_email,
    organizations: row.organizations ?? [],
    joinedAt: new Date(row.joined_at).toISOString(),
    lastActiveAt: new Date(row.last_active_at).toISOString(),
    actions30d: Number(row.actions_30d),
    publishes30d: Number(row.publishes_30d),
    pageOpens30d: Number(row.page_opens_30d),
    usesCli30d: row.uses_cli_30d === true,
    active7d: row.active_7d === true,
    areas30d: (row.areas_30d ?? []).filter((area): area is MetricsArea => (METRICS_AREAS as readonly string[]).includes(area)).sort(
      (a, b) => METRICS_AREAS.indexOf(a) - METRICS_AREAS.indexOf(b),
    ),
    staff: row.staff === true,
  }));
}

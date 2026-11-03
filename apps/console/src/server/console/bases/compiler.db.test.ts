import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/server/db/schema";
import type {
  BaseAggregateRequest,
  BaseFilter,
  BaseFilterLeaf,
  BaseProperty,
  BasePropertyConfig,
  BasePropertyType,
  BaseSelectOption,
  BaseSort,
} from "@/shared/bases/types";

import {
  baseQueryHash,
  buildBaseRowMatchQuery,
  buildBaseRowsQuery,
  compileBaseAggregate,
  compileBaseFilter,
  compileBaseSort,
  createBaseColumnResolver,
  type BaseCompileContext,
} from "./compiler";
import { decodeBaseCursor, encodeBaseCursor } from "./cursor";

// Runs only with BASES_TEST_DATABASE_URL (and DATABASE_URL) pointing at a
// migrated Console database. Creates its own organization and deletes it.
const url = process.env.BASES_TEST_DATABASE_URL;
const describeDb = url ? describe : describe.skip;

type Row = Record<string, unknown>;

const U1 = "8e0e034f-6cce-4f10-82da-3ebf2c8b49f4";
const U2 = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const U3 = "c9bf9e57-1685-4c89-bafb-ff5af830be8a";
const NOW = new Date("2026-10-06T15:00:00Z"); // Tuesday 12:00 in Sao Paulo
const TZ = "America/Sao_Paulo";

const L: BaseSelectOption = { id: "stg_lead", name: "Lead", color: "gray" };
const Q: BaseSelectOption = { id: "stg_qual", name: "Qualified", color: "blue" };
const O: BaseSelectOption = { id: "stg_old", name: "Old", color: "red", archived: true };
const W: BaseSelectOption = { id: "stg_won", name: "Won", color: "green" };
const DN: BaseSelectOption = { id: "st_done", name: "Done", color: "green", group: "done" };
const NS: BaseSelectOption = { id: "st_todo", name: "Not started", color: "gray", group: "todo" };
const SH: BaseSelectOption = { id: "st_ship", name: "Shipped", color: "purple", group: "done" };
const DO: BaseSelectOption = { id: "st_doing", name: "Doing", color: "blue", group: "in_progress" };
const TA: BaseSelectOption = { id: "tag_a", name: "Alpha", color: "gray" };
const TB: BaseSelectOption = { id: "tag_b", name: "Beta", color: "blue" };
const TG: BaseSelectOption = { id: "tag_g", name: "Gamma", color: "red" };

let position = 0;
function def(key: string, type: BasePropertyType, config: BasePropertyConfig = {}): BaseProperty {
  position += 1;
  return { id: randomUUID(), key, name: key, description: null, type, config, position, required: false, deletedAt: null };
}

const P = {
  name: def("name", "text"),
  amount: def("amount", "number"),
  done: def("done", "checkbox"),
  due: def("due", "date"),
  meeting: def("meeting", "date", { includeTime: true }),
  stage: def("stage", "select", { options: [L, Q, O, W] }),
  state: def("state", "status", { options: [DN, NS, SH, DO] }),
  tags: def("tags", "multi_select", { options: [TA, TB, TG] }),
  site: def("site", "url"),
  email: def("email", "email"),
  phone: def("phone", "phone"),
  owner: def("owner", "person"),
  links: def("links", "ref"),
};
type Key = keyof typeof P;

const d = (start: string, end: string | null = null) => ({ start, end });

type Fixture = {
  label: string;
  values: Partial<Record<Key, unknown>>;
  createdAt: string;
  updatedAt?: string;
  createdBy: string | null;
  updatedBy?: string | null;
  archived?: boolean;
  body?: string;
};

const FIXTURES: Fixture[] = [
  {
    label: "r01",
    values: {
      name: "Acme Corp", amount: 100, done: true, due: d("2026-10-06"), meeting: d("2026-10-06T13:00:00.000Z"),
      stage: L.id, state: NS.id, tags: [TA.id, TB.id], owner: [U1], links: [{ type: "artifact", id: "a1" }],
      site: "https://acme.com", email: "luis@example.com", phone: "+55 11 99999-0000",
    },
    createdAt: "2026-01-15T12:00:00.000Z", updatedAt: "2026-10-06T13:00:00.000Z", createdBy: U1, updatedBy: U2,
    body: "Hello **world**",
  },
  {
    label: "r02",
    values: {
      name: "acme labs", amount: 250.5, due: d("2026-10-01", "2026-10-10"),
      meeting: d("2026-10-06T02:30:00.000Z", "2026-10-06T04:00:00.000Z"), stage: Q.id, state: DO.id, tags: [TA.id],
      owner: [U1, U2], links: [{ type: "artifact", id: "a2" }, { type: "work.item", id: "w1" }],
      site: "http://labs.acme.com/x", email: "ana@acme.com", phone: "(11) 5555-1234",
    },
    createdAt: "2026-03-01T02:00:00.000Z", createdBy: U1,
  },
  {
    label: "r03",
    values: {
      name: "50% off_deal", amount: -10, done: true, due: d("2026-09-29"), meeting: d("2026-10-07T02:59:59.000Z"),
      stage: O.id, state: DN.id, tags: [TB.id, TG.id], owner: [U2], links: [{ type: "work.item", id: "a1" }],
      site: "https://example.org", email: "bob@example.org",
    },
    createdAt: "2026-03-01T04:00:00.000Z", createdBy: U1,
  },
  {
    label: "r04",
    values: {
      name: "Back\\slash", amount: 0, due: d("2026-10-13"), meeting: d("2026-10-07T03:00:00.000Z"), stage: W.id,
      state: SH.id, tags: [TG.id], email: "luis@example.com",
    },
    createdAt: "2026-06-10T12:00:00.000Z", createdBy: U1,
  },
  {
    label: "r05",
    values: {
      name: "Zeta", amount: 1000, done: true, due: d("2026-10-20"), meeting: d("2026-10-06T15:00:00.000Z"),
      stage: L.id, tags: [TA.id, TB.id, TG.id], owner: [U3],
    },
    createdAt: "2026-10-05T02:59:59.000Z", createdBy: U1,
  },
  {
    label: "r06",
    values: { name: "beta", amount: 100, due: d("2025-12-31"), meeting: d("2026-09-01T12:00:00.000Z"), state: DO.id, owner: [U1, U3] },
    createdAt: "2026-10-05T03:00:00.000Z", createdBy: U2,
  },
  {
    label: "r07",
    values: { name: "Alpha", done: true, due: d("2026-10-05", "2026-10-05"), stage: Q.id, state: DN.id, tags: [TB.id] },
    createdAt: "2026-10-06T10:00:00.000Z", createdBy: U2,
  },
  {
    label: "r08",
    values: { name: "Acme", amount: 99.99, stage: L.id, state: NS.id, owner: [U2, U3] },
    createdAt: "2026-10-06T14:00:00.000Z", createdBy: U2,
  },
  {
    label: "r09",
    values: { due: d("2026-10-11"), state: SH.id, tags: [TA.id, TG.id] },
    createdAt: "2026-10-06T14:30:00.000Z", createdBy: U2,
  },
  {
    label: "r10",
    values: { name: "Omega", amount: 1_000_000, due: d("2026-10-12"), stage: W.id, owner: [U1] },
    createdAt: "2025-12-31T23:00:00.000Z", createdBy: U2,
  },
  {
    label: "r11",
    values: { amount: 5, stage: Q.id, state: NS.id, tags: [TG.id] },
    createdAt: "2026-09-20T12:00:00.000Z", createdBy: null,
  },
  {
    label: "r12",
    values: { name: "50 percent", due: d("2026-11-01"), state: DO.id, owner: [U2] },
    createdAt: "2026-10-01T12:00:00.000Z", createdBy: U3,
  },
  {
    label: "rA",
    values: {
      name: "Acme", amount: 100, done: true, due: d("2026-10-06"), stage: L.id, state: NS.id, tags: [TA.id], owner: [U1],
      email: "luis@example.com",
    },
    createdAt: "2026-10-06T12:00:00.000Z", createdBy: U1, archived: true,
  },
];

const ACTIVE = FIXTURES.filter((row) => !row.archived).map((row) => row.label);
const rows = (...labels: string[]) => labels;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `r${String(from + i).padStart(2, "0")}`);

describeDb("bases compiler against Postgres", () => {
  const organizationId = randomUUID();
  const projectId = randomUUID();
  const baseId = randomUUID();
  const labelById = new Map<string, string>();
  const idByLabel = new Map<string, string>();
  let client: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;

  const context = (overrides: Partial<BaseCompileContext> = {}): BaseCompileContext => ({
    baseId,
    timezone: TZ,
    now: NOW,
    viewer: { raviUserId: U1, raviOrgId: organizationId, email: "Luis@Example.com" },
    resolve: createBaseColumnResolver(Object.values(P)),
    ...overrides,
  });

  async function run(query: SQL): Promise<Row[]> {
    return [...((await db.execute(query)) as unknown as Row[])];
  }

  async function query(filter: BaseFilter | null, sort: BaseSort[] = [], extra: { includeArchived?: boolean; ctx?: BaseCompileContext } = {}) {
    const ctx = extra.ctx ?? context();
    return run(
      buildBaseRowsQuery({
        organizationId,
        baseId,
        filterSql: compileBaseFilter(filter, ctx),
        sort: compileBaseSort(sort, ctx),
        limit: 500,
        includeArchived: extra.includeArchived ?? false,
        includeBody: true,
      }),
    );
  }

  const labelsOf = (result: Row[]) => result.map((row) => labelById.get(String(row.id)) ?? `?${String(row.id)}`);
  const matching = async (filter: BaseFilter) => labelsOf(await query(filter)).sort();
  const ordered = async (sort: BaseSort[], filter: BaseFilter | null = null) => labelsOf(await query(filter, sort));

  beforeAll(async () => {
    client = postgres(url as string, { max: 2, prepare: false, onnotice: () => {} });
    db = drizzle(client);
    await db.insert(schema.organizations).values({ id: organizationId, slug: `bases-test-${organizationId.slice(0, 8)}`, name: "Bases compiler test" });
    await db.insert(schema.projects).values({ id: projectId, organizationId, slug: "bases-test", name: "Bases compiler test" });
    await db.insert(schema.bases).values({
      id: baseId,
      organizationId,
      projectId,
      slug: "compiler",
      name: "Compiler",
      timezone: TZ,
      createdByActorType: "system",
      updatedByActorType: "system",
    });
    await db.insert(schema.baseProperties).values(
      Object.values(P).map((property) => ({
        id: property.id,
        baseId,
        organizationId,
        projectId,
        key: property.key,
        name: property.name,
        type: property.type,
        configJson: property.config as Record<string, unknown>,
        position: property.position,
      })),
    );
    for (const fixture of FIXTURES) {
      const id = randomUUID();
      labelById.set(id, fixture.label);
      idByLabel.set(fixture.label, id);
      const valuesJson: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fixture.values)) valuesJson[P[key as Key].id] = value;
      await db.insert(schema.baseRows).values({
        id,
        baseId,
        organizationId,
        projectId,
        valuesJson,
        body: fixture.body ?? null,
        archivedAt: fixture.archived ? new Date("2026-10-06T12:30:00Z") : null,
        createdByActorType: fixture.createdBy ? "user" : "system",
        createdByActorId: fixture.createdBy,
        updatedByActorType: (fixture.updatedBy === undefined ? fixture.createdBy : fixture.updatedBy) ? "user" : "system",
        updatedByActorId: fixture.updatedBy === undefined ? fixture.createdBy : fixture.updatedBy,
        createdAt: new Date(fixture.createdAt),
        updatedAt: new Date(fixture.updatedAt ?? fixture.createdAt),
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.execute(sql`DELETE FROM organizations WHERE id = ${organizationId}::uuid`);
    await client.end();
  });

  // [filter leaf, expected active rows]
  const CASES: Array<[BaseFilterLeaf, string[]]> = [
    // text
    [{ prop: "name", op: "eq", value: "Acme" }, rows("r08")],
    [{ prop: "name", op: "neq", value: "Acme" }, rows("r01", "r02", "r03", "r04", "r05", "r06", "r07", "r10", "r12")],
    [{ prop: "name", op: "contains", value: "acme" }, rows("r01", "r02", "r08")],
    [{ prop: "name", op: "not_contains", value: "acme" }, rows("r03", "r04", "r05", "r06", "r07", "r10", "r12")],
    [{ prop: "name", op: "starts_with", value: "ACME" }, rows("r01", "r02", "r08")],
    [{ prop: "name", op: "contains", value: "50%" }, rows("r03")],
    [{ prop: "name", op: "contains", value: "o_" }, rows()],
    [{ prop: "name", op: "contains", value: "\\" }, rows("r04")],
    [{ prop: "name", op: "starts_with", value: "50 " }, rows("r12")],
    [{ prop: "name", op: "is_empty" }, rows("r09", "r11")],
    [{ prop: "name", op: "is_not_empty" }, rows("r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08", "r10", "r12")],
    // url
    [{ prop: "site", op: "eq", value: "https://acme.com" }, rows("r01")],
    [{ prop: "site", op: "neq", value: "https://acme.com" }, rows("r02", "r03")],
    [{ prop: "site", op: "contains", value: "ACME" }, rows("r01", "r02")],
    [{ prop: "site", op: "not_contains", value: "acme" }, rows("r03")],
    [{ prop: "site", op: "starts_with", value: "https://" }, rows("r01", "r03")],
    [{ prop: "site", op: "is_empty" }, range(4, 12)],
    // email
    [{ prop: "email", op: "eq", value: "$viewer.email" }, rows("r01", "r04")],
    [{ prop: "email", op: "neq", value: "$viewer.email" }, rows("r02", "r03")],
    [{ prop: "email", op: "eq", value: "ANA@ACME.COM" }, rows("r02")],
    [{ prop: "email", op: "contains", value: "EXAMPLE" }, rows("r01", "r03", "r04")],
    [{ prop: "email", op: "not_contains", value: "example" }, rows("r02")],
    [{ prop: "email", op: "starts_with", value: "luis@" }, rows("r01", "r04")],
    [{ prop: "email", op: "is_not_empty" }, rows("r01", "r02", "r03", "r04")],
    // phone
    [{ prop: "phone", op: "eq", value: "(11) 5555-1234" }, rows("r02")],
    [{ prop: "phone", op: "contains", value: "5555" }, rows("r02")],
    [{ prop: "phone", op: "starts_with", value: "+55" }, rows("r01")],
    [{ prop: "phone", op: "is_empty" }, range(3, 12)],
    // number
    [{ prop: "amount", op: "eq", value: 100 }, rows("r01", "r06")],
    [{ prop: "amount", op: "neq", value: 100 }, rows("r02", "r03", "r04", "r05", "r08", "r10", "r11")],
    [{ prop: "amount", op: "lt", value: 0 }, rows("r03")],
    [{ prop: "amount", op: "lte", value: 0 }, rows("r03", "r04")],
    [{ prop: "amount", op: "gt", value: 250.5 }, rows("r05", "r10")],
    [{ prop: "amount", op: "gte", value: 250.5 }, rows("r02", "r05", "r10")],
    [{ prop: "amount", op: "between", value: [0, 100] }, rows("r01", "r04", "r06", "r08", "r11")],
    [{ prop: "amount", op: "between", value: [99.99, 99.99] }, rows("r08")],
    [{ prop: "amount", op: "is_empty" }, rows("r07", "r09", "r12")],
    // checkbox
    [{ prop: "done", op: "eq", value: true }, rows("r01", "r03", "r05", "r07")],
    [{ prop: "done", op: "eq", value: false }, rows("r02", "r04", "r06", "r08", "r09", "r10", "r11", "r12")],
    // date-only
    [{ prop: "due", op: "eq", value: "$today" }, rows("r01")],
    [{ prop: "due", op: "eq", value: "$now" }, rows("r01")],
    [{ prop: "due", op: "eq", value: "2026-10-05" }, rows("r07")],
    [{ prop: "due", op: "eq", value: "2026-10-06T02:00:00Z" }, rows("r07")],
    [{ prop: "due", op: "before", value: "2026-10-01" }, rows("r03", "r06")],
    [{ prop: "due", op: "after", value: "2026-10-10" }, rows("r04", "r05", "r09", "r10", "r12")],
    [{ prop: "due", op: "on_or_before", value: "2026-10-01" }, rows("r02", "r03", "r06")],
    [{ prop: "due", op: "on_or_after", value: "2026-10-12" }, rows("r04", "r05", "r10", "r12")],
    [{ prop: "due", op: "between", value: ["2026-10-07", "2026-10-11"] }, rows("r02", "r09")],
    [{ prop: "due", op: "between", value: ["$today", "2026-10-12"] }, rows("r01", "r02", "r09", "r10")],
    [{ prop: "due", op: "within", value: "today" }, rows("r01", "r02")],
    [{ prop: "due", op: "within", value: "this_week" }, rows("r01", "r02", "r07", "r09")],
    [{ prop: "due", op: "within", value: { past: "7d" } }, rows("r01", "r02", "r03", "r07")],
    [{ prop: "due", op: "within", value: { next: "1w" } }, rows("r01", "r02", "r04", "r09", "r10")],
    [{ prop: "due", op: "within", value: "this_month" }, rows("r01", "r02", "r04", "r05", "r07", "r09", "r10")],
    [{ prop: "due", op: "within", value: "this_year" }, rows("r01", "r02", "r03", "r04", "r05", "r07", "r09", "r10", "r12")],
    [{ prop: "due", op: "is_empty" }, rows("r08", "r11")],
    // date with time
    [{ prop: "meeting", op: "eq", value: "$today" }, rows("r01", "r03", "r05")],
    [{ prop: "meeting", op: "eq", value: "$now" }, rows("r05")],
    [{ prop: "meeting", op: "eq", value: "2026-10-06T10:00:00-03:00" }, rows("r01")],
    [{ prop: "meeting", op: "before", value: "2026-10-06" }, rows("r02", "r06")],
    [{ prop: "meeting", op: "after", value: "2026-10-06" }, rows("r04")],
    [{ prop: "meeting", op: "on_or_before", value: "2026-10-06" }, rows("r01", "r02", "r03", "r05", "r06")],
    [{ prop: "meeting", op: "on_or_after", value: "$today" }, rows("r01", "r03", "r04", "r05")],
    [{ prop: "meeting", op: "after", value: "$now" }, rows("r03", "r04")],
    [{ prop: "meeting", op: "before", value: "$now" }, rows("r01", "r02", "r06")],
    [{ prop: "meeting", op: "on_or_after", value: "$now" }, rows("r03", "r04", "r05")],
    [{ prop: "meeting", op: "on_or_before", value: "$now" }, rows("r01", "r02", "r05", "r06")],
    [{ prop: "meeting", op: "between", value: ["2026-10-06", "2026-10-06"] }, rows("r01", "r02", "r03", "r05")],
    [{ prop: "meeting", op: "between", value: ["2026-10-06T03:30:00Z", "$now"] }, rows("r01", "r02", "r05")],
    [{ prop: "meeting", op: "within", value: "today" }, rows("r01", "r02", "r03", "r05")],
    [{ prop: "meeting", op: "within", value: { past: "30d" } }, rows("r01", "r02", "r03", "r05")],
    [{ prop: "meeting", op: "is_empty" }, range(7, 12)],
    // select
    [{ prop: "stage", op: "eq", value: "Lead" }, rows("r01", "r05", "r08")],
    [{ prop: "stage", op: "neq", value: "lead" }, rows("r02", "r03", "r04", "r07", "r10", "r11")],
    [{ prop: "stage", op: "in", value: ["Qualified", "Old"] }, rows("r02", "r03", "r07", "r11")],
    [{ prop: "stage", op: "nin", value: ["Qualified", O.id] }, rows("r01", "r04", "r05", "r08", "r10")],
    [{ prop: "stage", op: "is_empty" }, rows("r06", "r09", "r12")],
    [{ prop: "stage", op: "is_not_empty" }, rows("r01", "r02", "r03", "r04", "r05", "r07", "r08", "r10", "r11")],
    // status
    [{ prop: "state", op: "eq", value: { group: "done" } }, rows("r03", "r04", "r07", "r09")],
    [{ prop: "state", op: "neq", value: { group: "done" } }, rows("r01", "r02", "r06", "r08", "r11", "r12")],
    [{ prop: "state", op: "eq", value: { group: "in_progress" } }, rows("r02", "r06", "r12")],
    [{ prop: "state", op: "eq", value: "Doing" }, rows("r02", "r06", "r12")],
    [{ prop: "state", op: "in", value: ["Done", "Shipped"] }, rows("r03", "r04", "r07", "r09")],
    [{ prop: "state", op: "nin", value: ["Not started"] }, rows("r02", "r03", "r04", "r06", "r07", "r09", "r12")],
    [{ prop: "state", op: "is_empty" }, rows("r05", "r10")],
    // multi_select
    [{ prop: "tags", op: "contains", value: "Alpha" }, rows("r01", "r02", "r05", "r09")],
    [{ prop: "tags", op: "not_contains", value: "alpha" }, rows("r03", "r04", "r07", "r11")],
    [{ prop: "tags", op: "contains_any", value: ["Beta", "Gamma"] }, rows("r01", "r03", "r04", "r05", "r07", "r09", "r11")],
    [{ prop: "tags", op: "contains_all", value: ["Alpha", "Beta"] }, rows("r01", "r05")],
    [{ prop: "tags", op: "is_empty" }, rows("r06", "r08", "r10", "r12")],
    // person
    [{ prop: "owner", op: "contains", value: "$viewer.raviUserId" }, rows("r01", "r02", "r06", "r10")],
    [{ prop: "owner", op: "not_contains", value: "$viewer.raviUserId" }, rows("r03", "r05", "r08", "r12")],
    [{ prop: "owner", op: "contains", value: U2 }, rows("r02", "r03", "r08", "r12")],
    [{ prop: "owner", op: "contains_any", value: [U2, U3] }, rows("r02", "r03", "r05", "r06", "r08", "r12")],
    [{ prop: "owner", op: "contains_all", value: [U1, U2] }, rows("r02")],
    [{ prop: "owner", op: "is_empty" }, rows("r04", "r07", "r09", "r11")],
    // ref
    [{ prop: "links", op: "contains", value: { type: "artifact", id: "a1" } }, rows("r01")],
    [{ prop: "links", op: "contains", value: { type: "work.item", id: "w1" } }, rows("r02")],
    [{ prop: "links", op: "is_not_empty" }, rows("r01", "r02", "r03")],
    // created_by / updated_by
    [{ prop: "created_by", op: "eq", value: "$viewer.raviUserId" }, range(1, 5)],
    [{ prop: "created_by", op: "neq", value: U1 }, [...range(6, 10), "r12"]],
    [{ prop: "created_by", op: "in", value: [U2, U3] }, [...range(6, 10), "r12"]],
    [{ prop: "created_by", op: "in", value: ["$viewer.raviUserId", U3] }, [...range(1, 5), "r12"]],
    [{ prop: "updated_by", op: "eq", value: U2 }, rows("r01", "r06", "r07", "r08", "r09", "r10")],
    [{ prop: "updated_by", op: "neq", value: U2 }, rows("r02", "r03", "r04", "r05", "r12")],
    // created_time / updated_time
    [{ prop: "created_time", op: "eq", value: "$today" }, rows("r07", "r08", "r09")],
    [{ prop: "created_time", op: "eq", value: "2026-03-01" }, rows("r03")],
    [{ prop: "created_time", op: "eq", value: "2026-02-28" }, rows("r02")],
    [{ prop: "created_time", op: "eq", value: "2026-10-06T14:00:00Z" }, rows("r08")],
    [{ prop: "created_time", op: "before", value: "2026-03-01" }, rows("r01", "r02", "r10")],
    [{ prop: "created_time", op: "after", value: "2026-10-05" }, rows("r07", "r08", "r09")],
    [{ prop: "created_time", op: "after", value: "2026-10-06T14:00:00Z" }, rows("r09")],
    [{ prop: "created_time", op: "on_or_before", value: "2026-10-04" }, rows("r01", "r02", "r03", "r04", "r05", "r10", "r11", "r12")],
    [{ prop: "created_time", op: "on_or_after", value: "2026-10-05" }, rows("r06", "r07", "r08", "r09")],
    [{ prop: "created_time", op: "between", value: ["2026-03-01", "2026-06-30"] }, rows("r03", "r04")],
    [{ prop: "created_time", op: "within", value: "this_week" }, rows("r06", "r07", "r08", "r09")],
    [{ prop: "created_time", op: "within", value: "this_month" }, rows("r05", "r06", "r07", "r08", "r09", "r12")],
    [{ prop: "created_time", op: "within", value: "this_year" }, range(1, 9).concat("r11", "r12")],
    [{ prop: "created_time", op: "within", value: { past: "1mo" } }, rows("r05", "r06", "r07", "r08", "r09", "r11", "r12")],
    [{ prop: "updated_time", op: "eq", value: "$today" }, rows("r01", "r07", "r08", "r09")],
    [{ prop: "updated_time", op: "before", value: "2026-01-01" }, rows("r10")],
  ];

  test("covers every operator of every column kind", () => {
    const seen = new Set(CASES.map(([leaf]) => {
      const column = createBaseColumnResolver(Object.values(P))(leaf.prop);
      return `${column?.kind}:${leaf.op}`;
    }));
    const expected = [
      "text:eq", "text:neq", "text:contains", "text:not_contains", "text:starts_with", "text:is_empty", "text:is_not_empty",
      "url:eq", "url:neq", "url:contains", "url:not_contains", "url:starts_with", "url:is_empty",
      "email:eq", "email:neq", "email:contains", "email:not_contains", "email:starts_with", "email:is_not_empty",
      "phone:eq", "phone:contains", "phone:starts_with", "phone:is_empty",
      "number:eq", "number:neq", "number:lt", "number:lte", "number:gt", "number:gte", "number:between", "number:is_empty",
      "checkbox:eq",
      "date:eq", "date:before", "date:after", "date:on_or_before", "date:on_or_after", "date:between", "date:within", "date:is_empty",
      "select:eq", "select:neq", "select:in", "select:nin", "select:is_empty", "select:is_not_empty",
      "status:eq", "status:neq", "status:in", "status:nin", "status:is_empty",
      "multi_select:contains", "multi_select:not_contains", "multi_select:contains_any", "multi_select:contains_all", "multi_select:is_empty",
      "person:contains", "person:not_contains", "person:contains_any", "person:contains_all", "person:is_empty",
      "ref:contains", "ref:is_not_empty",
      "created_by:eq", "created_by:neq", "created_by:in", "updated_by:eq", "updated_by:neq",
      "created_time:eq", "created_time:before", "created_time:after", "created_time:on_or_before", "created_time:on_or_after",
      "created_time:between", "created_time:within", "updated_time:eq", "updated_time:before",
    ];
    for (const entry of expected) expect(seen.has(entry)).toBe(true);
  });

  for (const [leaf, expected] of CASES) {
    test(`${leaf.prop} ${leaf.op} ${JSON.stringify(leaf.value ?? null)}`, async () => {
      const matched = await matching(leaf);
      expect(matched).toEqual([...expected].sort());
      const complement = await matching({ not: leaf });
      expect(complement).toEqual(ACTIVE.filter((label) => !expected.includes(label)).sort());
    });
  }

  test("logical combinations", async () => {
    expect(
      await matching({
        and: [
          { prop: "owner", op: "contains", value: "$viewer.raviUserId" },
          { or: [{ prop: "amount", op: "gte", value: 1000 }, { not: { prop: "stage", op: "is_empty" } }] },
        ],
      }),
    ).toEqual(["r01", "r02", "r10"]);
    expect(await matching({ or: [{ prop: "name", op: "is_empty" }, { prop: "done", op: "eq", value: true }] })).toEqual(
      ["r01", "r03", "r05", "r07", "r09", "r11"],
    );
  });

  test("archived rows are excluded unless requested", async () => {
    expect(labelsOf(await query({ prop: "name", op: "eq", value: "Acme" }, [], { includeArchived: true })).sort()).toEqual(["r08", "rA"]);
    expect(labelsOf(await query(null, [], { includeArchived: true }))).toHaveLength(13);
    expect(labelsOf(await query(null))).toHaveLength(12);
  });

  test("row shape", async () => {
    const [first] = await query({ prop: "name", op: "eq", value: "Acme Corp" });
    expect(first).toMatchObject({
      id: idByLabel.get("r01"),
      version: 1,
      body: "Hello **world**",
      archived_at: null,
      created_at: "2026-01-15T12:00:00.000Z",
      updated_at: "2026-10-06T13:00:00.000Z",
      created_by_actor_id: U1,
      updated_by_actor_id: U2,
      __s0: "2026-01-15T12:00:00.000000Z",
      __s1: idByLabel.get("r01"),
    });
    expect((first?.values_json as Record<string, unknown>)[P.tags.id]).toEqual([TA.id, TB.id]);
    const withoutBody = await run(
      buildBaseRowsQuery({
        organizationId,
        baseId,
        filterSql: compileBaseFilter({ prop: "name", op: "eq", value: "Acme Corp" }, context()),
        sort: compileBaseSort([], context()),
        limit: 1,
        includeArchived: false,
        includeBody: false,
      }),
    );
    expect(withoutBody[0]?.body).toBeNull();
  });

  test("rows are scoped by organization and base", async () => {
    const otherOrg = await run(
      buildBaseRowsQuery({
        organizationId: randomUUID(),
        baseId,
        filterSql: compileBaseFilter(null, context()),
        sort: compileBaseSort([], context()),
        limit: 500,
        includeArchived: true,
        includeBody: false,
      }),
    );
    expect(otherOrg).toHaveLength(0);
  });

  describe("sorting", () => {
    test("default is created_time ascending", async () => {
      expect(await ordered([])).toEqual(["r10", "r01", "r02", "r03", "r04", "r11", "r12", "r05", "r06", "r07", "r08", "r09"]);
      expect(await ordered([{ prop: "created_time", dir: "desc" }])).toEqual(
        ["r09", "r08", "r07", "r06", "r05", "r12", "r11", "r04", "r03", "r02", "r01", "r10"],
      );
    });

    test("numbers with empties last in both directions", async () => {
      expect(await ordered([{ prop: "amount", dir: "asc" }])).toEqual(
        ["r03", "r04", "r11", "r08", "r01", "r06", "r02", "r05", "r10", "r12", "r07", "r09"],
      );
      expect(await ordered([{ prop: "amount", dir: "desc" }])).toEqual(
        ["r10", "r05", "r02", "r01", "r06", "r08", "r11", "r04", "r03", "r12", "r07", "r09"],
      );
    });

    test("select by option order and status by group", async () => {
      expect(await ordered([{ prop: "stage", dir: "asc" }])).toEqual(
        ["r01", "r05", "r08", "r02", "r11", "r07", "r03", "r10", "r04", "r12", "r06", "r09"],
      );
      expect(await ordered([{ prop: "stage", dir: "desc" }])).toEqual(
        ["r10", "r04", "r03", "r02", "r11", "r07", "r01", "r05", "r08", "r12", "r06", "r09"],
      );
      expect(await ordered([{ prop: "state", dir: "asc" }])).toEqual(
        ["r01", "r11", "r08", "r02", "r12", "r06", "r03", "r07", "r04", "r09", "r10", "r05"],
      );
    });

    test("dates, instants, and checkboxes", async () => {
      expect(await ordered([{ prop: "due", dir: "asc" }])).toEqual(
        ["r06", "r03", "r02", "r07", "r01", "r09", "r10", "r04", "r05", "r12", "r11", "r08"],
      );
      expect(await ordered([{ prop: "due", dir: "desc" }])).toEqual(
        ["r12", "r05", "r04", "r10", "r09", "r01", "r07", "r02", "r03", "r06", "r11", "r08"],
      );
      expect(await ordered([{ prop: "meeting", dir: "asc" }])).toEqual(
        ["r06", "r02", "r01", "r05", "r03", "r04", "r10", "r11", "r12", "r07", "r08", "r09"],
      );
      expect(await ordered([{ prop: "done", dir: "desc" }])).toEqual(
        ["r01", "r03", "r05", "r07", "r10", "r02", "r04", "r11", "r12", "r06", "r08", "r09"],
      );
    });

    test("text sorts with empties last", async () => {
      const [{ collation } = { collation: "" }] = (await run(
        sql`SELECT datcollate AS collation FROM pg_database WHERE datname = current_database()`,
      )) as Array<{ collation: string }>;
      const asc = await ordered([{ prop: "name", dir: "asc" }]);
      const desc = await ordered([{ prop: "name", dir: "desc" }]);
      expect(asc.slice(-2)).toEqual(["r11", "r09"]);
      expect(desc.slice(-2)).toEqual(["r11", "r09"]);
      expect(desc.slice(0, -2)).toEqual(asc.slice(0, -2).reverse());
      if (/^(C|POSIX|C\.UTF-?8)$/i.test(collation)) {
        expect(asc).toEqual(["r12", "r03", "r08", "r01", "r07", "r04", "r10", "r05", "r02", "r06", "r11", "r09"]);
      }
    });
  });

  describe("keyset pagination", () => {
    async function paginate(sort: BaseSort[], pageSize: number, filter: BaseFilter | null = null) {
      const ctx = context();
      const compiledSort = compileBaseSort(sort, ctx);
      const filterSql = compileBaseFilter(filter, ctx);
      const binding = {
        scope: `base:${baseId}`,
        viewVersion: 0,
        schemaVersion: 1,
        queryHash: baseQueryHash({ filter, sort }),
        principal: `user:${U1}`,
      };
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 100; pages += 1) {
        const cursorValues: Array<string | null> | null = cursor ? decodeBaseCursor(cursor, binding).values : null;
        const result = await run(
          buildBaseRowsQuery({ organizationId, baseId, filterSql, sort: compiledSort, cursorValues, limit: pageSize, includeArchived: false, includeBody: false }),
        );
        const page = result.slice(0, pageSize);
        seen.push(...labelsOf(page));
        if (result.length <= pageSize) return seen;
        const last = page[page.length - 1] as Row;
        cursor = encodeBaseCursor({ ...binding, values: compiledSort.keys.map((_, index) => last[`__s${index}`] as string | null) });
      }
      throw new Error("pagination did not finish");
    }

    const SORTS: BaseSort[][] = [
      [],
      [{ prop: "amount", dir: "desc" }],
      [{ prop: "stage", dir: "asc" }, { prop: "amount", dir: "desc" }, { prop: "due", dir: "asc" }],
      [{ prop: "state", dir: "desc" }, { prop: "meeting", dir: "asc" }],
      [{ prop: "done", dir: "desc" }, { prop: "name", dir: "asc" }, { prop: "created_time", dir: "desc" }],
      [{ prop: "email", dir: "asc" }, { prop: "phone", dir: "desc" }, { prop: "site", dir: "asc" }],
      [{ prop: "due", dir: "desc" }, { prop: "updated_time", dir: "desc" }],
    ];

    for (const sort of SORTS) {
      test(`returns every row once for ${JSON.stringify(sort)}`, async () => {
        const full = await ordered(sort);
        expect(full).toHaveLength(12);
        for (const pageSize of [1, 2, 5]) {
          const paged = await paginate(sort, pageSize);
          expect(paged).toEqual(full);
          expect(new Set(paged).size).toBe(paged.length);
        }
      });
    }

    test("pagination respects the filter", async () => {
      const filter: BaseFilter = { prop: "stage", op: "is_not_empty" };
      const sort: BaseSort[] = [{ prop: "stage", dir: "desc" }, { prop: "amount", dir: "asc" }];
      expect(await paginate(sort, 2, filter)).toEqual(await ordered(sort, filter));
    });
  });

  describe("aggregation", () => {
    async function aggregate(request: BaseAggregateRequest, options: { policy?: BaseFilter; ctx?: BaseCompileContext } = {}) {
      const ctx = options.ctx ?? context();
      const compiled = compileBaseAggregate(request, ctx, {
        organizationId,
        policyFilterSql: options.policy ? compileBaseFilter(options.policy, ctx) : null,
      });
      return { compiled, rows: await run(compiled.query) };
    }

    const counts = (result: Row[], measure = "m_n") =>
      Object.fromEntries(result.map((row) => [String(row.g0 ?? "null"), row[measure]]));

    test("by select", async () => {
      const { rows: result } = await aggregate({ groupBy: [{ prop: "stage" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(result)).toEqual({ [L.id]: 3, [Q.id]: 3, [O.id]: 1, [W.id]: 2, null: 3 });
      expect(result.at(-1)?.g0).toBeNull();
      expect(result.map((row) => row.__count)).toEqual(result.map((row) => row.m_n));
    });

    test("by multi_select and person, one group per element", async () => {
      const tags = await aggregate({ groupBy: [{ prop: "tags" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(tags.rows)).toEqual({ [TA.id]: 4, [TB.id]: 4, [TG.id]: 5, null: 4 });
      const owners = await aggregate({ groupBy: [{ prop: "owner" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(owners.rows)).toEqual({ [U1]: 4, [U2]: 4, [U3]: 3, null: 4 });
    });

    test("by month in the base timezone", async () => {
      const request: BaseAggregateRequest = { groupBy: [{ prop: "created_time", timeUnit: "month" }], aggregate: [{ op: "count", as: "n" }] };
      const local = await aggregate(request);
      expect(local.rows.map((row) => [row.g0, row.m_n])).toEqual([
        ["2025-12-01", 1],
        ["2026-01-01", 1],
        ["2026-02-01", 1],
        ["2026-03-01", 1],
        ["2026-06-01", 1],
        ["2026-09-01", 1],
        ["2026-10-01", 6],
      ]);
      const utc = await aggregate(request, { ctx: context({ timezone: "UTC" }) });
      expect(counts(utc.rows)).toEqual({ "2025-12-01": 1, "2026-01-01": 1, "2026-03-01": 2, "2026-06-01": 1, "2026-09-01": 1, "2026-10-01": 6 });
    });

    test("by quarter, year, week, and day", async () => {
      const quarter = await aggregate({ groupBy: [{ prop: "created_time", timeUnit: "quarter" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(quarter.rows)).toEqual({ "2025-10-01": 1, "2026-01-01": 3, "2026-04-01": 1, "2026-07-01": 1, "2026-10-01": 6 });
      const year = await aggregate({ groupBy: [{ prop: "created_time", timeUnit: "year" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(year.rows)).toEqual({ "2025-01-01": 1, "2026-01-01": 11 });
      const week = await aggregate({ groupBy: [{ prop: "due", timeUnit: "week" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(week.rows)).toEqual({
        "2025-12-29": 1,
        "2026-09-28": 2,
        "2026-10-05": 3,
        "2026-10-12": 2,
        "2026-10-19": 1,
        "2026-10-26": 1,
        null: 2,
      });
      const day = await aggregate({ groupBy: [{ prop: "meeting", timeUnit: "day" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(day.rows)).toEqual({ "2026-09-01": 1, "2026-10-05": 1, "2026-10-06": 3, "2026-10-07": 1, null: 6 });
    });

    test("number sum, avg, min, max, count_values", async () => {
      const { rows: [totals] } = await aggregate({
        aggregate: [
          { op: "sum", prop: "amount", as: "sum" },
          { op: "avg", prop: "amount", as: "avg" },
          { op: "min", prop: "amount", as: "min" },
          { op: "max", prop: "amount", as: "max" },
          { op: "count_values", prop: "amount", as: "filled" },
          { op: "count", as: "n" },
        ],
      });
      expect(totals?.m_sum as number).toBeCloseTo(1_001_545.49, 6);
      expect(totals?.m_avg as number).toBeCloseTo(1_001_545.49 / 9, 6);
      expect(totals?.m_min).toBe(-10);
      expect(totals?.m_max).toBe(1_000_000);
      expect(totals?.m_filled).toBe(9);
      expect(totals?.m_n).toBe(12);
    });

    test("sum by select", async () => {
      const { rows: result } = await aggregate({ groupBy: [{ prop: "stage" }], aggregate: [{ op: "sum", prop: "amount", as: "total" }] });
      const totals = counts(result, "m_total");
      expect(totals[L.id] as number).toBeCloseTo(1199.99, 6);
      expect(totals[Q.id]).toBe(255.5);
      expect(totals[O.id]).toBe(-10);
      expect(totals[W.id]).toBe(1_000_000);
      expect(totals.null).toBe(100);
    });

    test("min and max of dates", async () => {
      const { rows: [result] } = await aggregate({
        aggregate: [
          { op: "min", prop: "due", as: "due_min" },
          { op: "max", prop: "due", as: "due_max" },
          { op: "min", prop: "meeting", as: "meeting_min" },
          { op: "max", prop: "meeting", as: "meeting_max" },
          { op: "min", prop: "created_time", as: "created_min" },
          { op: "max", prop: "created_time", as: "created_max" },
          { op: "count_values", prop: "tags", as: "tagged" },
        ],
      });
      expect(result).toMatchObject({
        m_due_min: "2025-12-31",
        m_due_max: "2026-11-01",
        m_meeting_min: "2026-09-01T12:00:00.000Z",
        m_meeting_max: "2026-10-07T03:00:00.000Z",
        m_created_min: "2025-12-31T23:00:00.000Z",
        m_created_max: "2026-10-06T14:30:00.000Z",
        m_tagged: 8,
      });
    });

    test("two dimensions, numbers, checkboxes, and actors", async () => {
      const two = await aggregate({ groupBy: [{ prop: "done" }, { prop: "stage" }], aggregate: [{ op: "count", as: "n" }] });
      expect(two.rows.map((row) => [row.g0, row.g1, row.m_n])).toEqual([
        [false, L.id, 1],
        [false, Q.id, 2],
        [false, W.id, 2],
        [false, null, 3],
        [true, L.id, 2],
        [true, O.id, 1],
        [true, Q.id, 1],
      ]);
      const numbers = await aggregate({ groupBy: [{ prop: "amount" }], aggregate: [{ op: "count", as: "n" }] });
      expect(numbers.rows.map((row) => [row.g0, row.m_n])).toEqual([
        [-10, 1], [0, 1], [5, 1], [99.99, 1], [100, 2], [250.5, 1], [1000, 1], [1_000_000, 1], [null, 3],
      ]);
      const actors = await aggregate({ groupBy: [{ prop: "created_by" }], aggregate: [{ op: "count", as: "n" }] });
      expect(counts(actors.rows)).toEqual({ [U1]: 5, [U2]: 5, [U3]: 1, null: 1 });
    });

    test("request filter and policy filter are both applied", async () => {
      const { rows: [result] } = await aggregate(
        { filter: { prop: "stage", op: "eq", value: "Lead" }, aggregate: [{ op: "count", as: "n" }] },
        { policy: { prop: "done", op: "eq", value: true } },
      );
      expect(result?.m_n).toBe(2);
    });
  });

  test("row match query checks the filter, archive state, and id", async () => {
    const ctx = context();
    const lead = compileBaseFilter({ prop: "stage", op: "eq", value: "Lead" }, ctx);
    const match = (label: string | null, filterSql: SQL) =>
      run(buildBaseRowMatchQuery({ organizationId, baseId, rowId: label ? (idByLabel.get(label) as string) : randomUUID(), filterSql }));
    expect(await match("r01", lead)).toEqual([{ id: idByLabel.get("r01"), version: 1 }]);
    expect(await match("r02", lead)).toEqual([]);
    expect(await match("rA", compileBaseFilter(null, ctx))).toEqual([]);
    expect(await match(null, compileBaseFilter(null, ctx))).toEqual([]);
    expect(await run(buildBaseRowMatchQuery({ organizationId, baseId, rowId: "not-a-uuid", filterSql: lead }))).toEqual([]);
  });
});

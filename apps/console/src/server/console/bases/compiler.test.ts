import { describe, expect, test } from "bun:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { ConsoleApiError } from "@/server/console/api-error";
import type { BaseFilter, BaseProperty, BasePropertyConfig, BasePropertyType } from "@/shared/bases/types";

import {
  baseFilterColumnRefs,
  baseFilterToApi,
  baseQueryHash,
  buildBaseRowMatchQuery,
  buildBaseRowsQuery,
  compileBaseAggregate,
  compileBaseFilter,
  compileBaseKeysetPredicate,
  compileBaseSearch,
  compileBaseSort,
  createBaseColumnResolver,
  normalizeBaseFilterForStorage,
  validateBaseFilter,
  type BaseCompileContext,
} from "./compiler";

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const BASE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "8e0e034f-6cce-4f10-82da-3ebf2c8b49f4";

let nextId = 0;
function prop(key: string, type: BasePropertyType, config: BasePropertyConfig = {}, extra: Partial<BaseProperty> = {}): BaseProperty {
  nextId += 1;
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    key,
    name: key,
    description: null,
    type,
    config,
    position: nextId,
    required: false,
    deletedAt: null,
    ...extra,
  };
}

const properties = {
  name: prop("name", "text"),
  amount: prop("amount", "number"),
  done: prop("done", "checkbox"),
  due: prop("due", "date"),
  meeting: prop("meeting", "date", { includeTime: true }),
  stage: prop("stage", "select", {
    options: [
      { id: "opt_lead", name: "Lead", color: "gray" },
      { id: "opt_qual", name: "Qualified", color: "blue" },
      { id: "opt_old", name: "Old", color: "red", archived: true },
    ],
  }),
  tags: prop("tags", "multi_select", {
    options: [
      { id: "tag_a", name: "Alpha", color: "gray" },
      { id: "tag_b", name: "Beta", color: "blue" },
    ],
  }),
  state: prop("state", "status", {
    options: [
      { id: "st_todo", name: "Not started", color: "gray", group: "todo" },
      { id: "st_doing", name: "Doing", color: "blue", group: "in_progress" },
      { id: "st_done", name: "Done", color: "green", group: "done" },
    ],
  }),
  site: prop("site", "url"),
  email: prop("email", "email"),
  phone: prop("phone", "phone"),
  owner: prop("owner", "person"),
  links: prop("links", "ref"),
  gone: prop("gone", "text", {}, { deletedAt: "2026-10-01T00:00:00.000Z" }),
};
const allProperties = Object.values(properties);

function context(overrides: Partial<BaseCompileContext> = {}): BaseCompileContext {
  return {
    baseId: BASE_ID,
    timezone: "America/Sao_Paulo",
    now: new Date("2026-10-06T15:00:00Z"),
    viewer: { raviUserId: USER_ID, raviOrgId: ORG_ID, email: "luis@example.com" },
    resolve: createBaseColumnResolver(allProperties),
    ...overrides,
  };
}

function apiError(fn: () => unknown): ConsoleApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConsoleApiError) return error;
    throw error;
  }
  throw new Error("expected a ConsoleApiError");
}

function expectInvalidFilter(filter: unknown, ctx = context()) {
  const error = apiError(() => compileBaseFilter(filter as BaseFilter, ctx));
  expect(error.status).toBe(400);
  expect(error.payload.error).toBe("invalid_filter");
  const validation = apiError(() => validateBaseFilter(filter as BaseFilter, ctx));
  expect(validation.payload.error).toBe("invalid_filter");
}

describe("filter validation", () => {
  test("accepts a filter with every column kind", () => {
    const filter: BaseFilter = {
      and: [
        { prop: "name", op: "contains", value: "acme" },
        { prop: "amount", op: "between", value: [1, 10] },
        { prop: "done", op: "eq", value: false },
        { prop: "due", op: "within", value: { past: "7d" } },
        { prop: "meeting", op: "on_or_after", value: "$now" },
        { prop: "stage", op: "in", value: ["Lead", "opt_qual"] },
        { prop: "tags", op: "contains_all", value: ["Alpha", "tag_b"] },
        { prop: "state", op: "neq", value: { group: "done" } },
        { prop: "site", op: "starts_with", value: "https://" },
        { prop: "email", op: "eq", value: "$viewer.email" },
        { prop: "phone", op: "is_empty" },
        { prop: "owner", op: "contains", value: "$viewer.raviUserId" },
        { prop: "links", op: "contains", value: { type: "artifact", id: "a1" } },
        { prop: "created_by", op: "in", value: ["$viewer.raviUserId", USER_ID] },
        { prop: "updated_time", op: "between", value: ["2026-01-01", "$today"] },
        { not: { prop: "created_time", op: "eq", value: "$today" } },
      ],
    };
    expect(() => validateBaseFilter(filter, context())).not.toThrow();
    expect(() => compileBaseFilter(filter, context())).not.toThrow();
  });

  test("null filters compile to TRUE", () => {
    expect(render(compileBaseFilter(null, context())).sql).toBe("TRUE");
    expect(render(compileBaseFilter(undefined, context())).sql).toBe("TRUE");
  });

  test("unknown operators", () => {
    expectInvalidFilter({ prop: "name", op: "like", value: "x" });
    expectInvalidFilter({ prop: "name", op: "regex", value: ".*" });
  });

  test("unknown operators and malformed nodes name the operator or the key at fault", () => {
    const reason = (filter: unknown) => {
      const error = apiError(() => compileBaseFilter(filter as BaseFilter, context()));
      expect(error.payload.error).toBe("invalid_filter");
      return (error.payload as { reason?: string }).reason;
    };
    expect(reason({ prop: "amount", op: "gtx", value: 1 })).toBe('Unknown operator "gtx".');
    expect(reason({ and: [{ prop: "amount", op: "gt", value: 1 }, { prop: "amount", op: "gte_", value: 1 }] })).toBe(
      'Unknown operator "gte_".',
    );
    expect(reason({ prop: "amount", value: 1 })).toBe('The condition on "amount" needs an op.');
    expect(reason({ prop: "amount", op: "gt", value: 1, extra: true })).toContain('Unknown filter key "extra"');
    expect(reason({ and: [{ prop: "amount", op: "gt", value: 1 }], limit: 5 })).toContain('Unexpected key "limit" beside "and"');
    expect(reason({ or: { prop: "amount", op: "gt", value: 1 } })).toBe('"or" takes an array of 1-32 filters.');
    expect(reason({ not: [{ prop: "amount", op: "gt", value: 1 }] })).toBe(
      "Filter nodes are objects (a condition, or and/or/not), not an array.",
    );
    expect(reason("amount > 1")).toBe("Filter nodes are objects (a condition, or and/or/not), not a string.");
  });

  test("operators that do not fit the column kind", () => {
    expectInvalidFilter({ prop: "amount", op: "contains", value: "1" });
    expectInvalidFilter({ prop: "done", op: "neq", value: true });
    expectInvalidFilter({ prop: "created_by", op: "contains", value: USER_ID });
    expectInvalidFilter({ prop: "stage", op: "contains", value: "Lead" });
    expectInvalidFilter({ prop: "tags", op: "eq", value: "Alpha" });
    expectInvalidFilter({ prop: "links", op: "contains_any", value: [{ type: "a", id: "1" }] });
    expectInvalidFilter({ prop: "created_time", op: "is_empty" });
  });

  test("type mismatches", () => {
    expectInvalidFilter({ prop: "amount", op: "eq", value: "12" });
    expectInvalidFilter({ prop: "amount", op: "between", value: [10, 1] });
    expectInvalidFilter({ prop: "amount", op: "between", value: [1] });
    expectInvalidFilter({ prop: "done", op: "eq", value: "true" });
    expectInvalidFilter({ prop: "name", op: "contains", value: 5 });
    expectInvalidFilter({ prop: "name", op: "eq", value: "" });
    expectInvalidFilter({ prop: "name", op: "eq" });
    expectInvalidFilter({ prop: "name", op: "is_empty", value: "x" });
    expectInvalidFilter({ prop: "stage", op: "in", value: [] });
    expectInvalidFilter({ prop: "stage", op: "eq", value: { group: "done" } });
    expectInvalidFilter({ prop: "state", op: "in", value: { group: "done" } });
    expectInvalidFilter({ prop: "state", op: "eq", value: { group: "later" } });
    expectInvalidFilter({ prop: "due", op: "eq", value: "tomorrow" });
    expectInvalidFilter({ prop: "due", op: "eq", value: "2026-02-30" });
    expectInvalidFilter({ prop: "due", op: "between", value: ["2026-10-07", "2026-10-06"] });
    expectInvalidFilter({ prop: "due", op: "within", value: { past: "0d" } });
    expectInvalidFilter({ prop: "due", op: "within", value: "yesterday" });
    expectInvalidFilter({ prop: "owner", op: "contains", value: "luis" });
    expectInvalidFilter({ prop: "links", op: "contains", value: { type: "Bad Type", id: "1" } });
    expectInvalidFilter({ prop: "created_by", op: "eq", value: "system" });
  });

  test("depth, leaves, and children limits", () => {
    let deep: BaseFilter = { prop: "name", op: "is_empty" };
    for (let i = 0; i < 8; i += 1) deep = { not: deep };
    expectInvalidFilter(deep);
    let ok: BaseFilter = { prop: "name", op: "is_empty" };
    for (let i = 0; i < 7; i += 1) ok = { not: ok };
    expect(() => compileBaseFilter(ok, context())).not.toThrow();

    const leaf: BaseFilter = { prop: "name", op: "is_empty" };
    const sixtyFive: BaseFilter = { and: [{ and: Array(32).fill(leaf) }, { and: Array(32).fill(leaf) }, leaf] };
    expectInvalidFilter(sixtyFive);
    const sixtyFour: BaseFilter = { and: [{ and: Array(32).fill(leaf) }, { and: Array(32).fill(leaf) }] };
    expect(() => compileBaseFilter(sixtyFour, context())).not.toThrow();
    expectInvalidFilter({ and: [] });
    expectInvalidFilter({ or: Array(33).fill(leaf) });
    expectInvalidFilter({ and: [leaf], or: [leaf] });
    expectInvalidFilter({ prop: "name", op: "is_empty", extra: true });
    expectInvalidFilter("name = 1");
  });

  test("unknown, deleted, and hidden properties share one error", () => {
    const unknown = apiError(() => compileBaseFilter({ prop: "nope", op: "is_empty" }, context()));
    expect(unknown.status).toBe(400);
    expect(unknown.payload).toEqual({ error: "unknown_property", reason: 'Unknown property "nope".' });

    const deleted = apiError(() => compileBaseFilter({ prop: "gone", op: "is_empty" }, context()));
    expect(deleted.payload.error).toBe("unknown_property");
    const deletedById = apiError(() => compileBaseFilter({ prop: properties.gone.id, op: "is_empty" }, context()));
    expect(deletedById.payload.error).toBe("unknown_property");

    const viewCtx = context({ resolve: createBaseColumnResolver(allProperties, { allowed: [properties.name.id, "created_time"] }) });
    const hidden = apiError(() => compileBaseFilter({ prop: "secret", op: "is_empty" }, viewCtx));
    const hiddenReal = apiError(() => compileBaseFilter({ prop: "amount", op: "is_empty" }, viewCtx));
    expect(hiddenReal.status).toBe(hidden.status);
    expect(hiddenReal.payload).toEqual({ error: "unknown_property", reason: 'Unknown property "amount".' });
    expect(() => compileBaseFilter({ prop: "name", op: "is_empty" }, viewCtx)).not.toThrow();
    expect(() => compileBaseFilter({ prop: "created_time", op: "eq", value: "$today" }, viewCtx)).not.toThrow();
    expect(apiError(() => compileBaseFilter({ prop: "body", op: "is_empty" }, context())).payload.error).toBe("unknown_property");
  });

  test("viewer variables only where the spec allows them", () => {
    expectInvalidFilter({ prop: "name", op: "eq", value: "$viewer.raviUserId" });
    expectInvalidFilter({ prop: "email", op: "contains", value: "$viewer.email" });
    expectInvalidFilter({ prop: "email", op: "eq", value: "$viewer.raviUserId" });
    expectInvalidFilter({ prop: "owner", op: "contains", value: "$viewer.email" });
    expectInvalidFilter({ prop: "owner", op: "contains_any", value: ["$viewer.raviUserId"] });
    expectInvalidFilter({ prop: "created_by", op: "eq", value: "$viewer.email" });
    expectInvalidFilter({ prop: "owner", op: "contains", value: "$viewer.foo" });
    expectInvalidFilter({ prop: "amount", op: "eq", value: "$today" });
    expectInvalidFilter({ prop: "stage", op: "eq", value: "$now" });
    expectInvalidFilter({ prop: "due", op: "eq", value: "$viewer.raviUserId" });
    expectInvalidFilter({ prop: "due", op: "within", value: "$today" });
    expectInvalidFilter({ prop: "links", op: "contains", value: { type: "user", id: "$viewer.raviUserId" } });
    // A "$" literal that is not a variable is plain text.
    expect(() => compileBaseFilter({ prop: "name", op: "eq", value: "$100" }, context())).not.toThrow();
  });

  test("NUL characters in filter values are invalid", () => {
    expectInvalidFilter({ prop: "name", op: "contains", value: "a\u0000" });
    expectInvalidFilter({ prop: "stage", op: "in", value: ["Lead", "x\u0000"] });
  });

  test("9999-12-31 compiles without an upper bound", () => {
    const filters: BaseFilter[] = [
      { prop: "meeting", op: "on_or_before", value: "9999-12-31" },
      { prop: "meeting", op: "eq", value: "9999-12-31" },
      { prop: "meeting", op: "after", value: "9999-12-31" },
      { prop: "meeting", op: "between", value: ["2020-01-01", "9999-12-31"] },
      { prop: "created_time", op: "before", value: "9999-12-31" },
      { prop: "updated_time", op: "on_or_before", value: "9999-12-31" },
      { prop: "due", op: "between", value: ["2020-01-01", "9999-12-31"] },
    ];
    for (const filter of filters) {
      const query = render(compileBaseFilter(filter, context()));
      const unbounded = "op" in filter && filter.prop !== "due" && filter.op !== "before";
      if (unbounded) expect(query.params).toContain("infinity");
    }
  });

  test("viewer variables without a viewer fail closed", () => {
    const filter: BaseFilter = { prop: "owner", op: "contains", value: "$viewer.raviUserId" };
    const noViewer = context({ viewer: null });
    for (const fn of [() => compileBaseFilter(filter, noViewer), () => validateBaseFilter(filter, noViewer)]) {
      const error = apiError(fn);
      expect(error.status).toBe(403);
      expect(error.payload).toEqual({ error: "base_forbidden", reason: "viewer_required" });
    }
    expect(() => validateBaseFilter(filter, noViewer, { allowMissingViewer: true })).not.toThrow();
    expect(() => normalizeBaseFilterForStorage(filter, noViewer)).not.toThrow();

    const nested: BaseFilter = { or: [{ prop: "name", op: "is_empty" }, { not: { prop: "created_by", op: "eq", value: "$viewer.raviUserId" } }] };
    expect(apiError(() => compileBaseFilter(nested, noViewer)).status).toBe(403);

    const noEmail = context({ viewer: { raviUserId: USER_ID, raviOrgId: ORG_ID, email: null } });
    expect(apiError(() => compileBaseFilter({ prop: "email", op: "eq", value: "$viewer.email" }, noEmail)).status).toBe(403);
    expect(() => compileBaseFilter({ prop: "email", op: "eq", value: "x@y.z" }, context({ viewer: null }))).not.toThrow();
    expect(() => compileBaseFilter({ prop: "meeting", op: "after", value: "$now" }, noViewer)).not.toThrow();
  });

  test("viewer values are bound from the context, never from the filter", () => {
    const { params } = render(compileBaseFilter({ prop: "owner", op: "contains", value: "$viewer.raviUserId" }, context()));
    expect(params).toContain(USER_ID);
    expect(params).not.toContain("$viewer.raviUserId");
  });
});

describe("option names and storage form", () => {
  test("normalizes keys to refs and option names to ids", () => {
    const filter: BaseFilter = {
      and: [
        { prop: "stage", op: "in", value: ["lead", "opt_qual", "LEAD"] },
        { prop: "tags", op: "contains", value: "beta" },
        { prop: "state", op: "eq", value: "doing" },
        { prop: "state", op: "neq", value: { group: "done" } },
        { prop: "email", op: "eq", value: "Luis@Example.com" },
        { prop: "meeting", op: "after", value: "2026-10-06T10:00:00-03:00" },
        { prop: "owner", op: "contains", value: USER_ID.toUpperCase() },
        { prop: "created_time", op: "within", value: "this_week" },
        { not: { prop: properties.name.id, op: "is_empty" } },
      ],
    };
    expect(normalizeBaseFilterForStorage(filter, context())).toEqual({
      and: [
        { prop: properties.stage.id, op: "in", value: ["opt_lead", "opt_qual"] },
        { prop: properties.tags.id, op: "contains", value: "tag_b" },
        { prop: properties.state.id, op: "eq", value: "st_doing" },
        { prop: properties.state.id, op: "neq", value: { group: "done" } },
        { prop: properties.email.id, op: "eq", value: "luis@example.com" },
        { prop: properties.meeting.id, op: "after", value: "2026-10-06T13:00:00.000Z" },
        { prop: properties.owner.id, op: "contains", value: USER_ID },
        { prop: "created_time", op: "within", value: "this_week" },
        { not: { prop: properties.name.id, op: "is_empty" } },
      ],
    });
  });

  test("unknown option names are invalid", () => {
    expectInvalidFilter({ prop: "stage", op: "eq", value: "Nope" });
    expectInvalidFilter({ prop: "tags", op: "contains_any", value: ["Alpha", "Gamma"] });
  });

  test("archived options keep compiling", () => {
    expect(normalizeBaseFilterForStorage({ prop: "stage", op: "eq", value: "Old" }, context())).toEqual({
      prop: properties.stage.id,
      op: "eq",
      value: "opt_old",
    });
  });

  test("an empty status group compiles to FALSE for eq", () => {
    const ctx = context({
      resolve: createBaseColumnResolver([
        prop("flow", "status", { options: [{ id: "x", name: "X", color: "gray", group: "todo" }] }),
      ]),
    });
    expect(render(compileBaseFilter({ prop: "flow", op: "eq", value: { group: "done" } }, ctx)).sql).toBe("FALSE");
  });

  test("baseFilterToApi and baseFilterColumnRefs", () => {
    const stored = normalizeBaseFilterForStorage(
      { or: [{ prop: "stage", op: "eq", value: "Lead" }, { not: { prop: "created_by", op: "eq", value: "$viewer.raviUserId" } }] },
      context(),
    );
    expect(baseFilterColumnRefs(stored)).toEqual(new Set([properties.stage.id, "created_by"]));
    const keys = new Map(allProperties.map((p) => [p.id, p.key]));
    expect(baseFilterToApi(stored, (ref) => keys.get(ref))).toEqual({
      or: [{ prop: "stage", op: "eq", value: "opt_lead" }, { not: { prop: "created_by", op: "eq", value: "$viewer.raviUserId" } }],
    });
    expect(baseFilterToApi(null, () => null)).toBeNull();
    expect(baseFilterColumnRefs(null).size).toBe(0);
  });
});

describe("parameterization", () => {
  const hostile = "x'); DROP TABLE base_rows; --";

  test("user strings and property ids are only parameters", () => {
    const filter: BaseFilter = {
      or: [
        { prop: "name", op: "eq", value: hostile },
        { prop: "name", op: "contains", value: "50%_off\\" },
        { prop: "email", op: "starts_with", value: hostile },
        { prop: "stage", op: "eq", value: "Lead" },
        { prop: "tags", op: "contains", value: "Alpha" },
        { prop: "links", op: "contains", value: { type: "artifact", id: hostile } },
        { prop: "amount", op: "gt", value: 5 },
        { prop: "due", op: "eq", value: "2026-10-06" },
        { prop: "created_by", op: "in", value: [USER_ID] },
      ],
    };
    const { sql, params } = render(compileBaseFilter(filter, context()));
    expect(sql).not.toContain("DROP");
    expect(sql).not.toContain("50%");
    expect(sql).not.toContain("opt_lead");
    expect(sql).not.toContain("tag_a");
    expect(sql).not.toContain("artifact");
    expect(sql).not.toContain("2026-10-06");
    expect(sql).not.toContain(USER_ID);
    for (const property of allProperties) expect(sql).not.toContain(property.id);
    expect(params).toContain(hostile);
    expect(params).toContain("%50\\%\\_off\\\\%");
    // Email operands are lowercased (stored emails are lowercase).
    expect(params).toContain(`${hostile.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    expect(params).toContain(properties.name.id);
    expect(params).toContain("opt_lead");
    expect(sql).toContain("ESCAPE E'\\\\'");
  });

  test("sort, rows, and aggregate queries bind ids and values", () => {
    const ctx = context();
    const sort = compileBaseSort([{ prop: "stage", dir: "desc" }, { prop: "name", dir: "asc" }], ctx);
    const rows = render(
      buildBaseRowsQuery({
        organizationId: ORG_ID,
        baseId: BASE_ID,
        filterSql: compileBaseFilter({ prop: "name", op: "eq", value: hostile }, ctx),
        sort,
        cursorValues: ["1", hostile, "2026-10-06T19:51:00.123456Z", "6e0b1a2c-0000-4000-8000-000000000002"],
        limit: 50,
        includeArchived: false,
        includeBody: true,
      }),
    );
    expect(rows.sql).not.toContain("DROP");
    expect(rows.sql).not.toContain(ORG_ID);
    expect(rows.sql).not.toContain(BASE_ID);
    for (const property of allProperties) expect(rows.sql).not.toContain(property.id);
    expect(rows.sql).toContain("LIMIT 51");
    expect(rows.sql).toContain('"__s0"');
    expect(rows.sql).toContain('"__s3"');
    expect(rows.params).toContain(ORG_ID);

    const aggregate = render(
      compileBaseAggregate(
        { groupBy: [{ prop: "tags" }, { prop: "meeting", timeUnit: "month" }], aggregate: [{ op: "sum", prop: "amount", as: "totalAmount" }, { op: "count", as: "n" }] },
        ctx,
        { organizationId: ORG_ID },
      ).query,
    );
    for (const property of allProperties) expect(aggregate.sql).not.toContain(property.id);
    expect(aggregate.sql).not.toContain("America/Sao_Paulo");
    expect(aggregate.params).toContain("America/Sao_Paulo");
    expect(aggregate.sql).toContain('"m_totalAmount"');
    expect(aggregate.sql).toContain("date_trunc('month'");
    expect(aggregate.sql).toContain("LIMIT 5001");
  });
});

describe("sort compilation", () => {
  test("appends tie-breakers", () => {
    const sort = compileBaseSort([{ prop: "amount", dir: "desc" }], context());
    expect(sort.keys.map((key) => [key.column?.key ?? null, key.dir, key.type, key.nullable])).toEqual([
      ["amount", "desc", "numeric", true],
      [null, "asc", "timestamptz", false],
      [null, "asc", "uuid", false],
    ]);
    const orderBy = render(sort.orderBy).sql;
    expect(orderBy).toContain("DESC NULLS LAST");
    expect(orderBy.endsWith("r.created_at ASC NULLS LAST, r.id ASC NULLS LAST")).toBe(true);
  });

  test("default sort is created_time ascending", () => {
    const sort = compileBaseSort([], context());
    expect(render(sort.orderBy).sql).toBe("r.created_at ASC NULLS LAST, r.id ASC NULLS LAST");
    const byCreated = compileBaseSort([{ prop: "created_time", dir: "desc" }], context());
    expect(byCreated.keys).toHaveLength(2);
  });

  test("rejects bad sorts", () => {
    for (const sort of [
      [{ prop: "tags", dir: "asc" }],
      [{ prop: "owner", dir: "asc" }],
      [{ prop: "links", dir: "asc" }],
      [{ prop: "created_by", dir: "asc" }],
      [{ prop: "name", dir: "up" }],
      [
        { prop: "name", dir: "asc" },
        { prop: "amount", dir: "asc" },
        { prop: "due", dir: "asc" },
        { prop: "stage", dir: "asc" },
      ],
    ]) {
      expect(apiError(() => compileBaseSort(sort as never, context())).payload.error).toBe("invalid_filter");
    }
    expect(apiError(() => compileBaseSort([{ prop: "nope", dir: "asc" }], context())).payload.error).toBe("unknown_property");
    expect(apiError(() => compileBaseSort([{ prop: "body", dir: "asc" }], context())).payload.error).toBe("unknown_property");
  });

  test("keyset cursor values must match the keys", () => {
    const sort = compileBaseSort([{ prop: "amount", dir: "asc" }], context());
    const good = ["12.5", "2026-10-06T19:51:00.123456Z", "6e0b1a2c-0000-4000-8000-000000000002"];
    expect(() => compileBaseKeysetPredicate(sort.keys, good)).not.toThrow();
    expect(() => compileBaseKeysetPredicate(sort.keys, [null, ...good.slice(1)])).not.toThrow();
    for (const bad of [
      good.slice(1),
      [...good, "x"],
      ["abc", ...good.slice(1)],
      [12.5, ...good.slice(1)],
      ["1", "2026-10-06", good[2]],
      ["1", null, good[2]],
      ["1", good[1], "not-a-uuid"],
    ]) {
      const error = apiError(() => compileBaseKeysetPredicate(sort.keys, bad));
      expect(error.payload).toEqual({ error: "cursor_invalid" });
    }
  });
});

describe("aggregate validation", () => {
  const ctx = context();
  const cases: Array<[unknown, string]> = [
    [{ groupBy: [{ prop: "stage" }, { prop: "tags" }, { prop: "done" }], aggregate: [{ op: "count", as: "n" }] }, "invalid_filter"],
    [{ groupBy: [{ prop: "due" }], aggregate: [{ op: "count", as: "n" }] }, "invalid_filter"],
    [{ groupBy: [{ prop: "stage", timeUnit: "month" }], aggregate: [{ op: "count", as: "n" }] }, "invalid_filter"],
    [{ groupBy: [{ prop: "created_time", timeUnit: "hour" }], aggregate: [{ op: "count", as: "n" }] }, "invalid_filter"],
    [{ groupBy: [{ prop: "name" }], aggregate: [{ op: "count", as: "n" }] }, "invalid_filter"],
    [{ groupBy: [{ prop: "stage" }, { prop: "stage" }], aggregate: [{ op: "count", as: "n" }] }, "invalid_filter"],
    [{ aggregate: [{ op: "count", prop: "amount", as: "n" }] }, "invalid_filter"],
    [{ aggregate: [{ op: "sum", prop: "name", as: "s" }] }, "invalid_filter"],
    [{ aggregate: [{ op: "sum", as: "s" }] }, "invalid_filter"],
    [{ aggregate: [{ op: "median", prop: "amount", as: "s" }] }, "invalid_filter"],
    [{ aggregate: [{ op: "count", as: "n" }, { op: "count", as: "n" }] }, "invalid_filter"],
    [{ aggregate: [{ op: "count", as: 'x" FROM users --' }] }, "invalid_filter"],
    [{ aggregate: [] }, "invalid_filter"],
    [{ groupBy: [{ prop: "nope" }], aggregate: [{ op: "count", as: "n" }] }, "unknown_property"],
    [{ aggregate: [{ op: "max", prop: "nope", as: "m" }] }, "unknown_property"],
    [{ filter: { prop: "nope", op: "is_empty" }, aggregate: [{ op: "count", as: "n" }] }, "unknown_property"],
  ];
  for (const [request, code] of cases) {
    test(`${JSON.stringify(request)} -> ${code}`, () => {
      const error = apiError(() => compileBaseAggregate(request as never, ctx, { organizationId: ORG_ID }));
      expect(error.payload.error).toBe(code);
    });
  }

  test("returns dimension and measure descriptors", () => {
    const compiled = compileBaseAggregate(
      { groupBy: [{ prop: "created_time", timeUnit: "week" }], aggregate: [{ op: "max", prop: "due", as: "latest" }, { op: "count", as: "n" }] },
      ctx,
      { organizationId: ORG_ID },
    );
    expect(compiled.dimensions.map((d) => [d.key, d.timeUnit])).toEqual([["created_time", "week"]]);
    expect(compiled.measures.map((m) => [m.as, m.op, m.column?.key ?? null])).toEqual([
      ["latest", "max", "due"],
      ["n", "count", null],
    ]);
  });
});

describe("row queries", () => {
  test("a malformed row id matches nothing", () => {
    const query = render(buildBaseRowMatchQuery({ organizationId: ORG_ID, baseId: BASE_ID, rowId: "nope", filterSql: compileBaseFilter(null, context()) }));
    expect(query.sql).toContain("WHERE FALSE");
  });

  test("limit is validated", () => {
    const sort = compileBaseSort([], context());
    for (const limit of [0, 501, 1.5]) {
      const error = apiError(() =>
        buildBaseRowsQuery({ organizationId: ORG_ID, baseId: BASE_ID, filterSql: compileBaseFilter(null, context()), sort, limit, includeArchived: false, includeBody: false }),
      );
      expect(error.payload.error).toBe("payload_invalid");
    }
  });
});

describe("baseQueryHash", () => {
  test("is stable across key order and sensitive to values", () => {
    expect(baseQueryHash({ a: 1, b: { c: [1, 2], d: null } })).toBe(baseQueryHash({ b: { d: null, c: [1, 2] }, a: 1 }));
    expect(baseQueryHash({ a: 1 })).not.toBe(baseQueryHash({ a: 2 }));
    expect(baseQueryHash({ a: [1, 2] })).not.toBe(baseQueryHash({ a: [2, 1] }));
    expect(baseQueryHash({ a: 1, b: undefined })).toBe(baseQueryHash({ a: 1 }));
    expect(baseQueryHash("x")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("approval and agent columns", () => {
  const approval = prop("review", "approval", { approvers: [{ kind: "project_role", minRole: "project_admin" }] });
  const agent = prop("summary", "agent", { instructions: "Resuma", inputs: [properties.name.id], output: "text" });
  const ctx = context({ resolve: createBaseColumnResolver([...allProperties, approval, agent]) });

  test("state_in takes one state or an array and reads the stored state", () => {
    const one = render(compileBaseFilter({ prop: "review", op: "state_in", value: "approved" }, ctx));
    expect(one.sql).toContain("->> 'state'");
    expect(one.params).toContain("approved");
    const many = render(compileBaseFilter({ prop: "summary", op: "state_in", value: ["pending", "error"] }, ctx));
    expect(many.sql).toContain("->> 'state'");
    expect(many.params).toEqual(expect.arrayContaining(["pending", "error"]));
  });

  test("state_in refuses unknown states, other operators, and sorting", () => {
    expectInvalidFilter({ prop: "review", op: "state_in", value: "done" }, ctx);
    expectInvalidFilter({ prop: "summary", op: "state_in", value: ["approved"] }, ctx);
    expectInvalidFilter({ prop: "review", op: "state_in", value: [] }, ctx);
    expectInvalidFilter({ prop: "review", op: "eq", value: "approved" }, ctx);
    expectInvalidFilter({ prop: "summary", op: "contains", value: "x" }, ctx);
    expectInvalidFilter({ prop: "name", op: "state_in", value: "pending" }, ctx);
    expect(() => compileBaseSort([{ prop: "review", dir: "asc" }], ctx)).toThrow();
    expect(() => compileBaseSort([{ prop: "summary", dir: "asc" }], ctx)).toThrow();
  });

  test("agent emptiness is about the filled value, not the pending state", () => {
    const empty = render(compileBaseFilter({ prop: "summary", op: "is_empty" }, ctx)).sql;
    expect(empty).toContain("-> 'value'");
    expect(render(compileBaseFilter({ prop: "review", op: "is_not_empty" }, ctx)).sql).not.toContain("-> 'value'");
  });
});

describe("search", () => {
  const columns = createSearchColumns();

  function createSearchColumns() {
    const resolve = createBaseColumnResolver(allProperties);
    return ["name", "amount", "stage", "tags", "state", "site", "email", "phone", "owner", "gone"].flatMap((key) => {
      const column = resolve(key);
      return column ? [column] : [];
    });
  }

  test("ORs a case-insensitive contains over text-like columns and matching option ids", () => {
    const query = render(compileBaseSearch("  QUAL ", columns));
    expect(query.sql).toContain("ILIKE");
    expect(query.sql).toContain(" OR ");
    expect(query.params).toContain("%QUAL%");
    // Option names match by name and compile to their ids; amount and owner are never searched.
    expect(query.params).toContain("opt_qual");
    expect(query.params).not.toContain("opt_lead");
  });

  test("escapes LIKE wildcards and ignores columns it cannot read", () => {
    expect(render(compileBaseSearch("50%_off", columns)).params).toContain("%50\\%\\_off%");
    expect(render(compileBaseSearch("acme", [])).sql).toBe("FALSE");
    const amountOnly = createBaseColumnResolver(allProperties)("amount");
    expect(render(compileBaseSearch("acme", amountOnly ? [amountOnly] : [])).sql).toBe("FALSE");
  });

  test("multi_select options match by containment", () => {
    const tags = createBaseColumnResolver(allProperties)("tags");
    const query = render(compileBaseSearch("beta", tags ? [tags] : []));
    expect(query.sql).toContain("@>");
    expect(query.params.some((param) => String(param).includes("tag_b"))).toBe(true);
  });
});

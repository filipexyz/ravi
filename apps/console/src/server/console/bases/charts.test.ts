import { describe, expect, test } from "bun:test";

import { chartAggregatePlan, chartSpecErrors } from "./charts";

describe("chart plans", () => {
  test("dimensions group, measures aggregate under their channel name", () => {
    const plan = chartAggregatePlan({
      x: { field: "created_time", timeUnit: "month", type: "temporal" },
      y: { aggregate: "sum", field: "amount", type: "quantitative" },
      color: { field: "status", type: "nominal" },
    });
    expect(plan.request).toEqual({
      groupBy: [{ prop: "created_time", timeUnit: "month" }, { prop: "status" }],
      aggregate: [{ op: "sum", prop: "amount", as: "y" }],
    });
    expect(plan.fields).toEqual(["created_time", "amount", "status"]);
    expect(plan.channels.map((channel) => [channel.channel, channel.role])).toEqual([
      ["x", "dimension"],
      ["y", "measure"],
      ["color", "dimension"],
    ]);
  });

  test("count needs no field and channels on the same field share a dimension", () => {
    const plan = chartAggregatePlan({
      x: { field: "status", type: "nominal" },
      color: { field: "status", type: "nominal" },
      y: { aggregate: "count", type: "quantitative" },
    });
    expect(plan.request).toEqual({ groupBy: [{ prop: "status" }], aggregate: [{ op: "count", as: "y" }] });
  });
});

describe("chart spec rules", () => {
  test("fields are required unless the aggregate is count; the body cannot be charted", () => {
    expect(chartSpecErrors({ mark: "bar", encoding: { x: { type: "nominal" }, y: { aggregate: "count", type: "quantitative" } } })).toEqual({
      "spec.encoding.x.field": "A field is required unless the aggregate is count.",
    });
    expect(
      chartSpecErrors({ mark: "bar", encoding: { x: { field: "body", type: "nominal" }, y: { aggregate: "count", type: "quantitative" } } }),
    ).toHaveProperty(["spec.encoding.x.field"]);
  });

  test("charts need a measure; theta goes with arc and arc needs theta", () => {
    expect(chartSpecErrors({ mark: "bar", encoding: { x: { field: "status", type: "nominal" } } })).toHaveProperty(["spec.encoding"]);
    expect(
      chartSpecErrors({ mark: "bar", encoding: { theta: { aggregate: "count", type: "quantitative" } } }),
    ).toHaveProperty(["spec.encoding.theta"]);
    expect(
      chartSpecErrors({ mark: { type: "arc", innerRadius: 40 }, encoding: { color: { field: "status", type: "nominal" }, y: { aggregate: "count", type: "quantitative" } } }),
    ).toHaveProperty(["spec.encoding.theta"]);
    expect(
      chartSpecErrors({ mark: "arc", encoding: { color: { field: "status", type: "nominal" }, theta: { aggregate: "count", type: "quantitative" } } }),
    ).toEqual({});
  });
});

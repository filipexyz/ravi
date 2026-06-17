import { describe, expect, test } from "bun:test";
import {
  getPipelineMetadataJsonSchema,
  type PipelineReviewFieldStatus,
  type PipelineValidationIssue,
  reviewPipelineMetadata,
  validatePipelineMetadata,
} from "./pipeline-metadata.js";

describe("validatePipelineMetadata", () => {
  test("empty object is valid (backward compat)", () => {
    const result = validatePipelineMetadata({});
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsed?.producers).toEqual([]);
    expect(result.parsed?.consumers).toEqual([]);
    expect(result.parsed?.stages).toEqual([]);
  });

  test("unknown top-level keys are preserved (passthrough)", () => {
    const result = validatePipelineMetadata({
      objetivo: "test",
      custom_field: "kept",
      another: { nested: true },
    });
    expect(result.ok).toBe(true);
    expect((result.parsed as Record<string, unknown>).custom_field).toBe("kept");
  });

  test("invalid priority_global rejected", () => {
    const result = validatePipelineMetadata({ priority_global: 99 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: PipelineValidationIssue) => e.path === "priority_global")).toBe(true);
  });

  test("invalid send_window hours rejected", () => {
    const result = validatePipelineMetadata({
      send_window: { hours: "invalid", timezone: "America/Sao_Paulo" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: PipelineValidationIssue) => e.path.startsWith("send_window"))).toBe(true);
  });

  test("invalid agent_id producer rejected", () => {
    const result = validatePipelineMetadata({ producers: ["UPPERCASE_invalid"] });
    expect(result.ok).toBe(false);
  });

  test("valid full document parses", () => {
    const result = validatePipelineMetadata({
      objetivo: "Qualificar leads",
      priority_global: 3,
      producers: ["analyst"],
      consumers: ["dispatcher"],
      versao: "1.0.0",
      vip_guard: { tag_triggers: ["vip"], action: "hitl" },
      send_window: { hours: "9-21", days: "mon-sat", timezone: "America/Sao_Paulo" },
      stages: [
        {
          key: "1-novo",
          ttl_days: 30,
          preconditions: [
            {
              type: "stale_task",
              max_days: 7,
              on_fail: { action: "cancel", reason: "task_stale" },
            },
          ],
        },
      ],
      regua_tags: [{ tag: "lifecycle:new", apply_when: { stage: "1-novo" }, linked_stage: "1-novo" }],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.parsed?.stages).toHaveLength(1);
    expect(result.parsed?.stages[0].preconditions).toHaveLength(1);
  });

  test("stage_key_drift warning when runtime keys provided", () => {
    const result = validatePipelineMetadata(
      {
        stages: [{ key: "1-novo" }, { key: "2-removed" }],
      },
      { runtimeStageKeys: ["1-novo"] },
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w: PipelineValidationIssue) => w.code === "stage_key_drift")).toBe(true);
  });

  test("missing core fields surfaced as warnings", () => {
    const result = validatePipelineMetadata({});
    expect(result.warnings.some((w: PipelineValidationIssue) => w.code === "missing_objetivo")).toBe(true);
    expect(result.warnings.some((w: PipelineValidationIssue) => w.code === "missing_priority_global")).toBe(true);
    expect(result.warnings.some((w: PipelineValidationIssue) => w.code === "missing_actors")).toBe(true);
  });

  test("unknown precondition type rejected", () => {
    const result = validatePipelineMetadata({
      stages: [
        {
          key: "1-novo",
          preconditions: [{ type: "foobar", on_fail: { action: "cancel" } }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("on_fail action validated", () => {
    const result = validatePipelineMetadata({
      stages: [
        {
          key: "1-novo",
          preconditions: [{ type: "stale_task", max_days: 7, on_fail: { action: "explode" } }],
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  test("null input rejected", () => {
    const result = validatePipelineMetadata(null);
    expect(result.ok).toBe(false);
  });

  test("undefined input rejected", () => {
    const result = validatePipelineMetadata(undefined);
    expect(result.ok).toBe(false);
  });

  test("negative ltv_threshold rejected", () => {
    const result = validatePipelineMetadata({
      vip_guard: { tag_triggers: [], ltv_threshold: -1, action: "hitl" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: PipelineValidationIssue) => e.path.startsWith("vip_guard"))).toBe(true);
  });

  test("negative priority_global rejected", () => {
    const result = validatePipelineMetadata({ priority_global: -1 });
    expect(result.ok).toBe(false);
  });

  test("zero ttl_days rejected (must be positive)", () => {
    const result = validatePipelineMetadata({ stages: [{ key: "1-novo", ttl_days: 0 }] });
    expect(result.ok).toBe(false);
  });

  test("uppercase consumer id rejected", () => {
    const result = validatePipelineMetadata({ consumers: ["UPPERCASE"] });
    expect(result.ok).toBe(false);
  });
});

describe("reviewPipelineMetadata", () => {
  test("empty metadata produces high-severity gaps", () => {
    const report = reviewPipelineMetadata({
      id: "crm_pipeline_x",
      name: "Test",
      metadata: {},
    });
    expect(report.pipelineId).toBe("crm_pipeline_x");
    expect(report.highSeverityGaps).toBeGreaterThan(0);
    expect(report.fields.some((f: PipelineReviewFieldStatus) => f.field === "objetivo" && f.present === "absent")).toBe(
      true,
    );
    expect(
      report.fields.some((f: PipelineReviewFieldStatus) => f.field === "priority_global" && f.present === "absent"),
    ).toBe(true);
  });

  test("full metadata produces zero high-severity gaps", () => {
    const report = reviewPipelineMetadata({
      id: "crm_pipeline_y",
      name: "Full",
      metadata: {
        objetivo: "Full pipeline",
        priority_global: 2,
        producers: ["analyst"],
        consumers: ["dispatcher"],
        versao: "1.0.0",
        vip_guard: { tag_triggers: ["vip"], action: "hitl" },
        send_window: { hours: "9-21", timezone: "America/Sao_Paulo" },
        stages: [
          {
            key: "1-novo",
            ttl_days: 30,
            preconditions: [{ type: "stale_task", max_days: 7, on_fail: { action: "cancel" } }],
          },
        ],
        regua_tags: [{ tag: "lifecycle:new", apply_when: { stage: "1-novo" } }],
      },
    });
    expect(report.highSeverityGaps).toBe(0);
  });

  test("partial stages metadata flagged", () => {
    const report = reviewPipelineMetadata({
      id: "crm_pipeline_z",
      name: "Partial",
      metadata: { stages: [{ key: "1-novo" }, { key: "2-second" }] },
    });
    const stageField = report.fields.find((f: PipelineReviewFieldStatus) => f.field === "stages");
    expect(stageField?.present).toBe("partial");
  });
});

describe("getPipelineMetadataJsonSchema", () => {
  test("returns Draft-07 JSON Schema with required structure", () => {
    const schema = getPipelineMetadataJsonSchema();
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(true);
    expect((schema.properties as Record<string, unknown>).objetivo).toBeDefined();
    expect((schema.properties as Record<string, unknown>).stages).toBeDefined();
  });
});

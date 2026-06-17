import { z } from "zod";

/**
 * Canonical schema for `pipeline.metadata` JSON.
 *
 * All fields are optional with sensible defaults so existing pipelines
 * (where `metadata` was free-form JSON) keep working without changes.
 * New pipelines that adopt these fields get help/validate/review tooling
 * plus engine consumers (precondition engine, send-window validator, TTL
 * sweep, VIP guard, etc).
 *
 * Backward-compat contract:
 * - Unknown top-level keys are preserved (passthrough).
 * - Missing optional fields produce no warnings.
 * - Schema validation is non-blocking by default — `validate` returns
 *   structured warnings/errors so callers decide enforcement policy.
 */

// --------------------------- Common primitives ---------------------------

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9:_-]*$/, "must be lowercase slug (a-z0-9:_-)")
  .describe("Lowercase identifier slug");

const agentIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/, "must be lowercase agent id")
  .describe("Agent id (lowercase)");

const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/i, "must be semver (e.g. 1.0.0 or 1.0.0-beta.1)")
  .describe("Semver version string");

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "must be ISO 8601 date (YYYY-MM-DD or full)")
  .describe("ISO 8601 date");

const ianaTimezoneSchema = z.string().min(3).describe("IANA timezone (e.g. America/Sao_Paulo)");

// --------------------------- POLICIES ---------------------------

export const vipGuardSchema = z
  .object({
    tag_triggers: z.array(slugSchema).default([]).describe("Tags that mark a contact as VIP and trigger this guard"),
    ltv_threshold: z
      .number()
      .nonnegative()
      .optional()
      .describe("Lifetime value threshold (currency-agnostic) above which contact is treated as VIP"),
    action: z
      .enum(["hitl", "block", "tag_only"])
      .default("hitl")
      .describe("hitl = require human approval; block = never send; tag_only = informational"),
  })
  .strict()
  .describe("VIP guard policy applied before any outbound send");

export type VipGuard = z.infer<typeof vipGuardSchema>;

export const sendWindowSchema = z
  .object({
    hours: z
      .string()
      .regex(/^(\d{1,2})-(\d{1,2})$/, "must be HH-HH (e.g. 9-21)")
      .describe("Allowed send window hours (24h format, inclusive start-exclusive end)"),
    days: z
      .string()
      .regex(
        /^(mon|tue|wed|thu|fri|sat|sun)(-(mon|tue|wed|thu|fri|sat|sun))?$/i,
        "must be range like mon-sat or single day like mon",
      )
      .optional()
      .describe("Allowed days of week (inclusive)"),
    timezone: ianaTimezoneSchema.describe("Timezone used to evaluate hours/days"),
  })
  .strict()
  .describe("Send window policy enforced by the dispatcher before outbound");

export type SendWindow = z.infer<typeof sendWindowSchema>;

/**
 * Free-form condition atom evaluated at runtime by the engine.
 *
 * ENGINE CONTRACT (review M2): consumers MUST validate atom shape before use
 * — atoms with unknown keys are ignored (fail-open). See
 * `evaluateHitlRequiredWhen` in `./pipeline-engines.ts` for supported atoms
 * (has_tag, lacks_tag, contact_value_above, ltv_above). New engine
 * implementations MUST preserve fail-open semantics (no throw on unknown).
 */
const conditionAtomSchema = z
  .record(z.string(), z.unknown())
  .describe(
    "Condition atom evaluated at runtime. Engine consumers MUST validate atom shape before use; unknown atoms are ignored (fail-open).",
  );

export const hitlRequiredWhenSchema = z
  .object({
    conditions: z.array(conditionAtomSchema).default([]),
    description: z.string().optional(),
  })
  .strict()
  .describe("When a send requires HITL approval based on declarative conditions");

export type HitlRequiredWhen = z.infer<typeof hitlRequiredWhenSchema>;

// --------------------------- COMMUNICATION ---------------------------

export const messageRuleSchema = z
  .object({
    prefix: z.string().optional().describe("Prefix prepended to every outbound message body"),
    suffix: z.string().optional().describe("Suffix appended to every outbound message body"),
  })
  .strict()
  .describe("Message formatting rules applied at send time");

export type MessageRule = z.infer<typeof messageRuleSchema>;

export const analystGuidanceSchema = z
  .object({
    tone: z.string().optional().describe("Free-form tone description (e.g. 'cordial, concise, no emojis')"),
    mandatory_mentions: z
      .array(z.string())
      .default([])
      .describe("Topics/strings that must appear in every analyst-drafted message"),
    avoid: z.array(z.string()).default([]).describe("Topics/strings the analyst must NOT include"),
  })
  .strict()
  .describe("Guidance applied by analyst agents drafting messages for this pipeline");

export type AnalystGuidance = z.infer<typeof analystGuidanceSchema>;

// --------------------------- STAGES ---------------------------

const preconditionActionSchema = z
  .object({
    action: z
      .enum(["cancel", "tag_and_archive", "tag_and_hitl", "tag_and_skip", "escalate"])
      .describe("Action taken when the precondition fails"),
    reason: z.string().optional().describe("Reason string written to audit logs"),
    tag: slugSchema.optional().describe("Tag attached to contact on failure (if action involves tagging)"),
  })
  .strict();

export const preconditionSpecSchema = z
  .object({
    type: z
      .enum([
        "stale_task",
        "stale_message",
        "no_inbound_after_task_created",
        "no_human_outbound_after_task_created",
        "stale_days_max",
        "frequency_anomaly",
        "seasonality",
      ])
      .describe("Precondition handler type recognised by the engine"),
    max_days: z.number().int().positive().optional(),
    max_hours: z.number().int().positive().optional(),
    field: z.string().optional().describe("Task metadata field name (used by stale_days_max)"),
    baseline_window: z
      .enum(["3m", "6m", "12m"])
      .optional()
      .describe("Historical window used as baseline (frequency_anomaly)"),
    threshold_pct: z.number().positive().optional(),
    detection_rule: z.string().optional(),
    tolerance_days: z.number().int().nonnegative().optional(),
    on_fail: preconditionActionSchema.describe("Action applied when this precondition fails"),
  })
  .strict()
  .describe("Single precondition declared on a stage");

export type PreconditionSpec = z.infer<typeof preconditionSpecSchema>;

const predicateSpecSchema = z
  .object({
    type: z.string().describe("Predicate handler type"),
    params: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .describe("Declarative predicate evaluated by engine");

const transitionSpecSchema = z
  .object({
    event: z.string().describe("Event name that triggers the transition"),
    guard: predicateSpecSchema.optional().describe("Optional guard predicate"),
    target: z.string().describe("Target stage key"),
    entry_action: z.record(z.string(), z.unknown()).optional(),
    side_effects: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict()
  .describe("Stage transition declaration consumed by pipeline engine");

export const stageMetadataSchema = z
  .object({
    key: slugSchema.describe("Stage key (must match the runtime stage)"),
    ttl_days: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Auto-archive opportunities sitting in this stage longer than ttl_days"),
    preconditions: z
      .array(preconditionSpecSchema)
      .default([])
      .describe("Preconditions evaluated by the dispatcher before outbound send"),
    entry_criteria: z.array(predicateSpecSchema).default([]),
    transitions: z.array(transitionSpecSchema).default([]),
    terminal: z.boolean().default(false).describe("Whether this stage is terminal (no more transitions)"),
    waiting: z.boolean().default(false).describe("Whether this stage is awaiting external event/time"),
    owner: agentIdSchema.optional().describe("Default owner agent for opportunities sitting in this stage"),
  })
  .passthrough()
  .describe("Per-stage metadata block");

export type StageMetadata = z.infer<typeof stageMetadataSchema>;

// --------------------------- TAGS ---------------------------

export const reguaTagSpecSchema = z
  .object({
    tag: slugSchema.describe("Tag attached when apply_when matches"),
    apply_when: z
      .record(z.string(), z.unknown())
      .describe("Condition map evaluated against opportunity/contact/derivations"),
    linked_stage: slugSchema.optional().describe("Stage that this tag drives the opportunity into"),
    apply_by: z.string().optional().describe("Component responsible for applying (e.g. cron id, agent id)"),
  })
  .strict()
  .describe("Régua tag specification (declarative tag-stage mapping)");

export type ReguaTagSpec = z.infer<typeof reguaTagSpecSchema>;

// --------------------------- INTEGRATIONS ---------------------------

export const failureModeSchema = z
  .object({
    id: slugSchema,
    descricao: z.string(),
    mitigacao: z.string(),
  })
  .strict()
  .describe("Known failure mode and its mitigation");

export const migrationEntrySchema = z
  .object({
    versao: semverSchema,
    data: isoDateSchema,
    autor: z.string(),
    mudanca: z.string(),
  })
  .strict()
  .describe("Migration history entry");

// --------------------------- ROOT METADATA SCHEMA ---------------------------

export const pipelineMetadataSchema = z
  .object({
    // IDENTITY
    objetivo: z.string().max(2000).optional().describe("One-paragraph natural-language statement of pipeline purpose"),
    priority_global: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe("Cross-pipeline arbitration priority (1 = highest, 5 = lowest)"),
    producers: z.array(agentIdSchema).default([]).describe("Agents that create/move opportunities into this pipeline"),
    consumers: z.array(agentIdSchema).default([]).describe("Agents that read this pipeline (analysts, dispatchers)"),
    reading_list_id: slugSchema.optional().describe("Reading list (chat queue) slug bound to this pipeline"),
    versao: semverSchema.optional().describe("Semver of this metadata document"),

    // POLICIES
    vip_guard: vipGuardSchema.optional(),
    send_window: sendWindowSchema.optional(),
    hitl_required_when: hitlRequiredWhenSchema.optional(),

    // COMMUNICATION
    message_rule: messageRuleSchema.optional(),
    analyst_guidance: analystGuidanceSchema.optional(),

    // STAGES (per-stage blocks, keyed by stage key)
    stages: z
      .array(stageMetadataSchema)
      .default([])
      .describe("Per-stage metadata blocks. Each entry MUST reference a stage that exists at the pipeline runtime."),

    // TAGS
    regua_tags: z.array(reguaTagSpecSchema).default([]),
    universal_tags_relevantes: z
      .array(slugSchema)
      .default([])
      .describe("Universal tags relevant to this pipeline (read-only, for traceability)"),

    // INTEGRATIONS
    related_crons: z.array(z.string()).default([]),
    related_triggers: z.array(z.string()).default([]),
    failure_modes_conhecidos: z.array(failureModeSchema).default([]),
    migration_history: z.array(migrationEntrySchema).default([]),
  })
  .passthrough()
  .describe("Canonical pipeline.metadata document (all fields optional, passthrough preserves unknown keys)");

export type PipelineMetadata = z.infer<typeof pipelineMetadataSchema>;

// --------------------------- VALIDATION + INTROSPECTION ---------------------------

export interface PipelineValidationIssue {
  path: string;
  message: string;
  severity: "warning" | "error";
  code?: string;
}

export interface PipelineValidationResult {
  ok: boolean;
  errors: PipelineValidationIssue[];
  warnings: PipelineValidationIssue[];
  parsed: PipelineMetadata | null;
}

/**
 * Validate raw pipeline.metadata against the canonical schema.
 *
 * Returns a structured result so callers can choose to enforce errors or
 * just surface warnings. Unknown top-level keys do NOT produce errors
 * (passthrough). Stage entries with invalid `key` slug produce errors.
 *
 * @param raw `pipeline.metadata` value from CRM (any JSON).
 * @param opts Optional context (e.g. runtime stage keys to cross-check).
 */
export function validatePipelineMetadata(
  raw: unknown,
  opts: { runtimeStageKeys?: string[] } = {},
): PipelineValidationResult {
  const result = pipelineMetadataSchema.safeParse(raw);

  if (!result.success) {
    const errors: PipelineValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      severity: "error",
      code: issue.code,
    }));
    return { ok: false, errors, warnings: [], parsed: null };
  }

  const parsed = result.data;
  const warnings: PipelineValidationIssue[] = [];

  // Cross-check stage keys vs runtime if provided.
  if (opts.runtimeStageKeys && parsed.stages.length > 0) {
    const runtimeSet = new Set(opts.runtimeStageKeys);
    for (let i = 0; i < parsed.stages.length; i++) {
      const stage = parsed.stages[i];
      if (!runtimeSet.has(stage.key)) {
        warnings.push({
          path: `stages[${i}].key`,
          message: `Stage key "${stage.key}" declared in metadata but not present at runtime`,
          severity: "warning",
          code: "stage_key_drift",
        });
      }
    }
  }

  // Surface metadata "smells" as warnings.
  if (!parsed.objetivo) {
    warnings.push({
      path: "objetivo",
      message: "Missing objetivo (one-line purpose statement)",
      severity: "warning",
      code: "missing_objetivo",
    });
  }
  if (parsed.priority_global === undefined) {
    warnings.push({
      path: "priority_global",
      message: "Missing priority_global (used by cross-pipeline arbitration)",
      severity: "warning",
      code: "missing_priority_global",
    });
  }
  if (parsed.producers.length === 0 && parsed.consumers.length === 0) {
    warnings.push({
      path: "producers/consumers",
      message: "No producers/consumers declared (hard to discover from CLI)",
      severity: "warning",
      code: "missing_actors",
    });
  }

  return { ok: true, errors: [], warnings, parsed };
}

/**
 * Field group used by `pipeline review` to organise the report.
 */
export type PipelineReviewGroup = "identidade" | "estrutura" | "politicas" | "tags" | "comunicacao" | "integracoes";

export interface PipelineReviewFieldStatus {
  group: PipelineReviewGroup;
  field: string;
  present: "present" | "absent" | "partial";
  detail: string;
  suggestion?: string;
}

export interface PipelineReviewReport {
  pipelineId: string;
  pipelineName: string;
  fields: PipelineReviewFieldStatus[];
  highSeverityGaps: number;
  totalGaps: number;
}

/**
 * Produce a human-readable review of a pipeline.metadata, used by
 * `ravi crm pipeline review`. The 12 fields below cover the canonical
 * model — each is classified as present / absent / partial with a
 * suggestion when applicable.
 */
export function reviewPipelineMetadata(
  pipeline: { id: string; name: string; metadata: unknown },
  opts: { runtimeStageKeys?: string[] } = {},
): PipelineReviewReport {
  const validation = validatePipelineMetadata(pipeline.metadata, opts);
  const parsed = validation.parsed ?? (pipeline.metadata as Partial<PipelineMetadata> | null) ?? {};

  const fields: PipelineReviewFieldStatus[] = [];
  let highSeverityGaps = 0;

  function mark(
    group: PipelineReviewGroup,
    field: string,
    condition: boolean,
    detailPresent: string,
    detailAbsent: string,
    suggestion?: string,
    highSeverity = false,
  ) {
    const present = condition ? "present" : "absent";
    fields.push({
      group,
      field,
      present,
      detail: condition ? detailPresent : detailAbsent,
      suggestion: condition ? undefined : suggestion,
    });
    if (!condition && highSeverity) highSeverityGaps++;
  }

  function markPartial(group: PipelineReviewGroup, field: string, detail: string, suggestion?: string) {
    fields.push({ group, field, present: "partial", detail, suggestion });
  }

  // IDENTIDADE (5 fields)
  mark(
    "identidade",
    "objetivo",
    typeof parsed.objetivo === "string" && parsed.objetivo.length > 0,
    `objetivo: "${(parsed.objetivo ?? "").slice(0, 80)}"`,
    "objetivo missing",
    "Add a one-paragraph statement of pipeline purpose",
    true,
  );
  mark(
    "identidade",
    "priority_global",
    typeof parsed.priority_global === "number",
    `priority_global = ${parsed.priority_global}`,
    "priority_global missing",
    "Set priority_global 1-5 for cross-pipeline arbitration",
    true,
  );
  mark(
    "identidade",
    "producers",
    Array.isArray(parsed.producers) && parsed.producers.length > 0,
    `producers: ${(parsed.producers ?? []).join(", ")}`,
    "producers list empty",
    "Declare agents that create opportunities in this pipeline",
  );
  mark(
    "identidade",
    "consumers",
    Array.isArray(parsed.consumers) && parsed.consumers.length > 0,
    `consumers: ${(parsed.consumers ?? []).join(", ")}`,
    "consumers list empty",
    "Declare agents that read/act on this pipeline (analysts, dispatchers)",
  );
  mark(
    "identidade",
    "versao",
    typeof parsed.versao === "string" && parsed.versao.length > 0,
    `versao = ${parsed.versao}`,
    "versao missing",
    "Tag metadata with semver for change tracking",
  );

  // ESTRUTURA (1 field: stages)
  const stagesArr = Array.isArray(parsed.stages) ? parsed.stages : [];
  if (stagesArr.length === 0) {
    mark(
      "estrutura",
      "stages",
      false,
      "",
      "stages list empty",
      "Add per-stage metadata (ttl_days, preconditions, transitions)",
      true,
    );
  } else {
    const withTtl = stagesArr.filter((s) => typeof s.ttl_days === "number").length;
    const withPrecond = stagesArr.filter((s) => Array.isArray(s.preconditions) && s.preconditions.length > 0).length;
    const detail = `stages declared: ${stagesArr.length} (ttl_days: ${withTtl}, preconditions: ${withPrecond})`;
    if (withTtl === 0 && withPrecond === 0) {
      markPartial(
        "estrutura",
        "stages",
        detail,
        "Stages declared but no ttl_days/preconditions — consumer engines won't fire",
      );
    } else {
      fields.push({ group: "estrutura", field: "stages", present: "present", detail });
    }
  }

  // POLITICAS (3 fields)
  mark(
    "politicas",
    "vip_guard",
    Boolean(parsed.vip_guard),
    `vip_guard action=${parsed.vip_guard?.action}, tags=${(parsed.vip_guard?.tag_triggers ?? []).length}`,
    "vip_guard missing",
    "Set vip_guard to enforce HITL on high-value contacts",
  );
  mark(
    "politicas",
    "send_window",
    Boolean(parsed.send_window),
    `send_window ${parsed.send_window?.hours} ${parsed.send_window?.days ?? "all-days"} ${parsed.send_window?.timezone}`,
    "send_window missing",
    "Declare send_window (CDC/legal compliance per timezone)",
  );
  mark(
    "politicas",
    "hitl_required_when",
    Boolean(parsed.hitl_required_when && parsed.hitl_required_when.conditions.length > 0),
    `hitl_required_when conditions: ${parsed.hitl_required_when?.conditions.length}`,
    "hitl_required_when not configured",
    "Optional: declare conditional HITL rules",
  );

  // COMUNICACAO (2 fields)
  mark(
    "comunicacao",
    "message_rule",
    Boolean(parsed.message_rule),
    `message_rule prefix=${Boolean(parsed.message_rule?.prefix)} suffix=${Boolean(parsed.message_rule?.suffix)}`,
    "message_rule missing",
    "Optional: standardise message prefix/suffix",
  );
  mark(
    "comunicacao",
    "analyst_guidance",
    Boolean(parsed.analyst_guidance),
    `analyst_guidance tone=${parsed.analyst_guidance?.tone ?? "?"}`,
    "analyst_guidance missing",
    "Declare tone/mandatory_mentions/avoid for analyst-drafted messages",
  );

  // TAGS (1 field)
  mark(
    "tags",
    "regua_tags",
    Array.isArray(parsed.regua_tags) && parsed.regua_tags.length > 0,
    `regua_tags count: ${(parsed.regua_tags ?? []).length}`,
    "regua_tags empty",
    "Declare régua tag specs if pipeline uses tag-driven stage progression",
  );

  // INTEGRACOES (no severity but good to have)
  mark(
    "integracoes",
    "related_crons",
    Array.isArray(parsed.related_crons) && parsed.related_crons.length > 0,
    `related_crons: ${(parsed.related_crons ?? []).length}`,
    "related_crons empty",
    "Reference CRON ids that drive this pipeline",
  );

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    fields,
    highSeverityGaps,
    totalGaps: fields.filter((f) => f.present !== "present").length,
  };
}

/**
 * Export the JSON Schema (Draft-07 compatible) for documentation/CI.
 * Used by `ravi crm pipeline validate --schema-json` to print the schema.
 */
export function getPipelineMetadataJsonSchema(): Record<string, unknown> {
  // zod doesn't ship native JSON Schema export; describe shape manually
  // for the documented fields. Tooling (`pipeline validate --schema-json`)
  // emits this object; runtime validation uses the zod schema above.
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://ravi.bot/schemas/crm/pipeline-metadata.v1.json",
    title: "Ravi CRM Pipeline Metadata",
    description:
      "Canonical schema for pipeline.metadata. All fields optional with sensible defaults. Unknown keys are preserved (passthrough). See src/crm/pipeline-metadata.ts for runtime zod validator.",
    type: "object",
    additionalProperties: true,
    properties: {
      objetivo: { type: "string", maxLength: 2000 },
      priority_global: { type: "integer", minimum: 1, maximum: 5 },
      producers: { type: "array", items: { type: "string" } },
      consumers: { type: "array", items: { type: "string" } },
      reading_list_id: { type: "string" },
      versao: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$" },
      vip_guard: {
        type: "object",
        properties: {
          tag_triggers: { type: "array", items: { type: "string" } },
          ltv_threshold: { type: "number", minimum: 0 },
          action: { type: "string", enum: ["hitl", "block", "tag_only"] },
        },
      },
      send_window: {
        type: "object",
        required: ["hours", "timezone"],
        properties: {
          hours: { type: "string", pattern: "^\\d{1,2}-\\d{1,2}$" },
          days: { type: "string" },
          timezone: { type: "string" },
        },
      },
      hitl_required_when: {
        type: "object",
        properties: {
          conditions: { type: "array", items: { type: "object" } },
          description: { type: "string" },
        },
      },
      message_rule: {
        type: "object",
        properties: { prefix: { type: "string" }, suffix: { type: "string" } },
      },
      analyst_guidance: {
        type: "object",
        properties: {
          tone: { type: "string" },
          mandatory_mentions: { type: "array", items: { type: "string" } },
          avoid: { type: "array", items: { type: "string" } },
        },
      },
      stages: {
        type: "array",
        items: {
          type: "object",
          required: ["key"],
          properties: {
            key: { type: "string" },
            ttl_days: { type: "integer", minimum: 1 },
            preconditions: {
              type: "array",
              items: {
                type: "object",
                required: ["type", "on_fail"],
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "stale_task",
                      "stale_message",
                      "no_inbound_after_task_created",
                      "no_human_outbound_after_task_created",
                      "stale_days_max",
                      "frequency_anomaly",
                      "seasonality",
                    ],
                  },
                  max_days: { type: "integer", minimum: 1 },
                  max_hours: { type: "integer", minimum: 1 },
                  field: { type: "string" },
                  baseline_window: { type: "string", enum: ["3m", "6m", "12m"] },
                  threshold_pct: { type: "number", exclusiveMinimum: 0 },
                  detection_rule: { type: "string" },
                  tolerance_days: { type: "integer", minimum: 0 },
                  on_fail: {
                    type: "object",
                    required: ["action"],
                    properties: {
                      action: {
                        type: "string",
                        enum: ["cancel", "tag_and_archive", "tag_and_hitl", "tag_and_skip", "escalate"],
                      },
                      reason: { type: "string" },
                      tag: { type: "string" },
                    },
                  },
                },
              },
            },
            entry_criteria: { type: "array", items: { type: "object" } },
            transitions: { type: "array", items: { type: "object" } },
            terminal: { type: "boolean" },
            waiting: { type: "boolean" },
            owner: { type: "string" },
          },
        },
      },
      regua_tags: {
        type: "array",
        items: {
          type: "object",
          required: ["tag", "apply_when"],
          properties: {
            tag: { type: "string" },
            apply_when: { type: "object" },
            linked_stage: { type: "string" },
            apply_by: { type: "string" },
          },
        },
      },
      universal_tags_relevantes: { type: "array", items: { type: "string" } },
      related_crons: { type: "array", items: { type: "string" } },
      related_triggers: { type: "array", items: { type: "string" } },
      failure_modes_conhecidos: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "descricao", "mitigacao"],
          properties: {
            id: { type: "string" },
            descricao: { type: "string" },
            mitigacao: { type: "string" },
          },
        },
      },
      migration_history: {
        type: "array",
        items: {
          type: "object",
          required: ["versao", "data", "autor", "mudanca"],
          properties: {
            versao: { type: "string" },
            data: { type: "string" },
            autor: { type: "string" },
            mudanca: { type: "string" },
          },
        },
      },
    },
  };
}

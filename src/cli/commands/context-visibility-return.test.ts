import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  contextSkillVisibilityEvidenceReturnSchema,
  contextVisibilityReturnSchema,
} from "./operational-return-schemas.js";
import { buildRuntimeSessionVisibilityPayload } from "../../runtime/session-visibility.js";
import {
  buildSkillVisibilitySnapshot,
  markLoadedFromRaviSkillToolCall,
  markLoadedFromSkillGate,
} from "../../runtime/skill-visibility.js";
import type { RuntimeSkillVisibilityEvidence } from "../../runtime/types.js";
import type { SessionEntry } from "../../router/types.js";

type EvidenceReturn = z.infer<typeof contextSkillVisibilityEvidenceReturnSchema>;
type MissingEvidenceKeys = Exclude<keyof RuntimeSkillVisibilityEvidence, keyof EvidenceReturn>;
type _AssertSchemaAcceptsRuntimeEvidence = MissingEvidenceKeys extends never ? true : MissingEvidenceKeys;
const _evidenceSchemaCoversRuntime: _AssertSchemaAcceptsRuntimeEvidence = true;
void _evidenceSchemaCoversRuntime;

/** The pre-fix contract that rejected runtime evidence and triggered RETURN_SHAPE_ERROR. */
const legacyContextVisibilityReturnSchema = z
  .object({
    sessionKey: z.string(),
    agentId: z.string(),
    provider: z.string().nullable(),
    tokens: z
      .object({
        used: z.number().nullable(),
        limit: z.number().nullable(),
        remaining: z.number().nullable(),
      })
      .strict(),
    compact: z
      .object({
        threshold: z.number().nullable(),
        willCompactAt: z.number().nullable(),
        lastCompactedAt: z.number().nullable(),
        count: z.number(),
      })
      .strict(),
    skills: z.array(
      z
        .object({
          id: z.string(),
          provider: z.string(),
          state: z.string(),
          confidence: z.string(),
          source: z.string().optional(),
          evidence: z
            .array(
              z
                .object({
                  kind: z.string(),
                  itemId: z.string().optional(),
                  detail: z.string().optional(),
                })
                .strict(),
            )
            .optional(),
          loadedAt: z.number().nullable().optional(),
          lastSeenAt: z.number(),
        })
        .strict(),
    ),
    loadedSkills: z.array(z.string()),
    lastUpdatedAt: z.number(),
  })
  .strict();

function buildRuntimeVisibilityPayload(): ReturnType<typeof buildRuntimeSessionVisibilityPayload> {
  const catalog = buildSkillVisibilitySnapshot(
    [
      {
        id: "pages",
        provider: "claude",
        state: "advertised",
        confidence: "declared",
        source: "plugin:ravi-system/pages",
        lastSeenAt: 1,
      },
    ],
    1,
  );
  const afterGate = markLoadedFromSkillGate(catalog, {
    provider: "claude",
    skill: "pages",
    source: "catalog:ravi-system/pages",
    path: "/plugins/ravi-system/skills/pages/SKILL.md",
    toolName: "Bash",
    now: 2,
  });
  const afterShow = markLoadedFromRaviSkillToolCall(afterGate, {
    provider: "claude",
    toolName: "exec_command",
    toolInput: { command: "ravi skills show pages --json" },
    output: { skill: { name: "pages", pluginName: "ravi-system" } },
    metadata: { turn: { id: "turn_vis_1" }, item: { id: "item_vis_1" } },
    now: 3,
  });
  const persisted = {
    ...afterShow,
    skills: afterShow.skills.map((skill) => ({
      ...skill,
      evidence: [
        ...(skill.evidence ?? []),
        {
          kind: "provider-event" as const,
          observedAt: 4,
          eventType: "skill.visibility.loaded",
          eventId: "evt_vis_1",
          turnId: "turn_vis_1",
          path: "/plugins/ravi-system/skills/pages/SKILL.md",
          detail: "provider loaded confirmation",
        },
      ],
    })),
  };

  const session: SessionEntry = {
    sessionKey: "agent:dev:main",
    name: "dev-main",
    agentId: "dev",
    agentCwd: "/tmp/ravi-dev",
    createdAt: 1000,
    updatedAt: 2000,
    runtimeProvider: "claude",
    runtimeSessionParams: { skillVisibility: persisted },
  };

  return buildRuntimeSessionVisibilityPayload(session);
}

describe("context visibility return schema", () => {
  it("legacy evidence contract rejects the fields the runtime actually emits", () => {
    const payload = buildRuntimeVisibilityPayload();
    const parsed = legacyContextVisibilityReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const messages = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    expect(messages.some((message) => message.includes("observedAt"))).toBe(true);
    expect(messages.some((message) => message.includes("path"))).toBe(true);
    expect(messages.some((message) => message.includes("eventType"))).toBe(true);
    expect(messages.some((message) => message.includes("eventId"))).toBe(true);
    expect(messages.some((message) => message.includes("turnId"))).toBe(true);
  });

  it("accepts a runtime-produced visibility payload that previously RETURN_SHAPE_ERROR'd", () => {
    const payload = buildRuntimeVisibilityPayload();
    const evidence = payload.skills[0]?.evidence ?? [];
    expect(evidence.some((entry) => entry.observedAt != null)).toBe(true);
    expect(evidence.some((entry) => entry.path != null)).toBe(true);
    expect(evidence.some((entry) => entry.eventType != null)).toBe(true);
    expect(evidence.some((entry) => entry.eventId != null)).toBe(true);
    expect(evidence.some((entry) => entry.turnId != null)).toBe(true);

    const parsed = contextVisibilityReturnSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    }
    expect(parsed.data.sessionKey).toBe("agent:dev:main");
    expect(parsed.data.loadedSkills).toEqual(["pages"]);
  });
});

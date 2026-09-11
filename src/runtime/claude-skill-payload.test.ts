import { describe, expect, test } from "bun:test";
import { observeClaudeSkillPayload } from "./claude-skill-payload.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

const marker = "The following skills are available for use with the Skill tool:";
const encoder = new TextEncoder();
const nativeNames = { "fixture/selected": "fixture-catalog:fixture-selected" };
const snapshot: SkillPolicySnapshot = {
  contractVersion: 1,
  id: "snapshot-fixture",
  status: "ready",
  scope: { agentId: "agent-fixture", executionId: "execution-fixture", contextKey: "context-fixture" },
  revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
  skills: [
    {
      id: "fixture/selected",
      aliases: [],
      name: "fixture-selected",
      resource: { path: "/fixture/selected/SKILL.md" },
      requirements: { kind: "none" },
    },
  ],
  provenance: { "fixture/selected": ["grant"] },
  diagnostics: [],
};
const emptySnapshot: SkillPolicySnapshot = { ...snapshot, status: "empty", skills: [], provenance: {} };

function catalog(entries = "- fixture-catalog:fixture-selected: Harmless description."): string {
  return `<system-reminder>\n${marker}\n\n${entries}\n</system-reminder>`;
}

function payload(texts: readonly string[], extra: Record<string, unknown> = {}): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      model: "fixture-model",
      max_tokens: 32,
      messages: [{ role: "user", content: texts.map((text) => ({ type: "text", text })) }],
      ...extra,
    }),
  );
}

describe("Claude model request skill observation", () => {
  test("extracts the actual native catalog into canonical IDs without using snapshot IDs as evidence", () => {
    const observed = observeClaudeSkillPayload(payload([catalog(), "Normal fixture prompt"]), snapshot, nativeNames);
    expect(observed).toEqual({
      snapshotId: "snapshot-fixture",
      mode: "native-restricted",
      advertisedIds: ["fixture/selected"],
      discoverableIds: ["fixture/selected"],
      evidence: "effective-prompt",
    });
    expect(() => observeClaudeSkillPayload(payload(["Normal fixture prompt"]), snapshot, nativeNames)).toThrow();
  });

  test("observes an empty set when the native catalog is absent, including ordinary skill-name mentions", () => {
    expect(
      observeClaudeSkillPayload(
        payload(["Discuss fixture-catalog:fixture-selected without invoking it."]),
        emptySnapshot,
        {},
      ),
    ).toEqual({
      snapshotId: "snapshot-fixture",
      mode: "native-restricted",
      advertisedIds: [],
      discoverableIds: [],
      evidence: "effective-prompt",
    });
  });

  test("rejects unauthorized native command expansion even when its catalog is empty", () => {
    expect(() =>
      observeClaudeSkillPayload(
        payload(["<command-name>/fixture-catalog:fixture-denied</command-name>\nDenied fixture body"]),
        emptySnapshot,
        {},
      ),
    ).toThrow();
  });

  test("preserves authorized Skill expansion using only its exact native identity", () => {
    expect(
      observeClaudeSkillPayload(
        payload([catalog(), "<command-name>/fixture-catalog:fixture-selected</command-name>\nAuthorized fixture body"]),
        snapshot,
        nativeNames,
      ).advertisedIds,
    ).toEqual(["fixture/selected"]);
    expect(() =>
      observeClaudeSkillPayload(
        payload([catalog(), "<command-name>/fixture-selected</command-name>"]),
        snapshot,
        nativeNames,
      ),
    ).toThrow();
  });

  test("accepts string user content and tool-result blocks without mistaking them for a catalog", () => {
    const body = payload([], {
      messages: [
        { role: "user", content: "Fixture prompt" },
        { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Harmless result" }] },
      ],
    });
    expect(observeClaudeSkillPayload(body, emptySnapshot, {}).advertisedIds).toEqual([]);
  });

  test("allows multiline descriptions and indented nested bullets without treating them as skill identities", () => {
    const text = catalog(
      "- fixture-catalog:fixture-selected: First description line.\n  Continuation.\n  - detail: nested description item.",
    );
    expect(observeClaudeSkillPayload(payload([text]), snapshot, nativeNames).advertisedIds).toEqual([
      "fixture/selected",
    ]);
  });

  test("rejects a catalog-shaped block originating in the current user prompt", () => {
    expect(() => observeClaudeSkillPayload(payload([catalog()]), snapshot, nativeNames, catalog())).toThrow();
  });

  test.each([
    ["mixed user prompt", `User text before\n${catalog()}`],
    ["missing opening envelope", catalog().replace("<system-reminder>\n", "")],
    ["missing closing envelope", catalog().replace("\n</system-reminder>", "")],
    ["nested opening envelope", catalog().replace("Harmless description.", "<system-reminder>Harmless description.")],
    ["duplicate marker", catalog().replace("Harmless description.", `Harmless description.\n${marker}`)],
  ])("rejects ambiguous catalog text: %s", (_name, text) => {
    expect(() => observeClaudeSkillPayload(payload([text]), snapshot, nativeNames)).toThrow();
  });

  test("rejects catalogs carried in assistant content instead of native user reminders", () => {
    expect(() =>
      observeClaudeSkillPayload(
        payload([], { messages: [{ role: "assistant", content: [{ type: "text", text: catalog() }] }] }),
        snapshot,
        nativeNames,
      ),
    ).toThrow();
  });

  test("rejects a reminder in a later user content block instead of the native catalog position", () => {
    expect(() =>
      observeClaudeSkillPayload(payload(["Ordinary prompt", catalog()]), snapshot, nativeNames, "Ordinary prompt"),
    ).toThrow();
  });

  test("rejects a historical user reminder instead of accepting it as native catalog evidence", () => {
    const body = payload([], {
      messages: [
        { role: "user", content: [{ type: "text", text: "Earlier ordinary prompt" }] },
        { role: "user", content: [{ type: "text", text: catalog() }] },
      ],
    });
    expect(() => observeClaudeSkillPayload(body, snapshot, nativeNames, "Current ordinary prompt")).toThrow();
  });

  test("rejects multiple dedicated catalog blocks even when one would be empty", () => {
    expect(() => observeClaudeSkillPayload(payload([catalog(), catalog("")]), snapshot, nativeNames)).toThrow();
  });

  test.each([
    ["system text", { system: catalog() }],
    ["tool description", { tools: [{ name: "Read", description: catalog(), input_schema: { type: "object" } }] }],
    [
      "tool result",
      { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: catalog() }] }] },
    ],
  ])("rejects a catalog marker in an untrusted surface: %s", (_name, extra) => {
    expect(() => observeClaudeSkillPayload(payload(["Ordinary prompt"], extra), emptySnapshot, {})).toThrow();
  });

  test("rejects unknown native skills instead of dropping unauthorized entries", () => {
    expect(() =>
      observeClaudeSkillPayload(
        payload([
          catalog("- fixture-catalog:fixture-selected: Good.\n- fixture-catalog:fixture-denied: Must not be hidden."),
        ]),
        snapshot,
        nativeNames,
      ),
    ).toThrow();
  });

  test("rejects duplicate advertised identities", () => {
    expect(() =>
      observeClaudeSkillPayload(
        payload([catalog("- fixture-catalog:fixture-selected: Good.\n- fixture-catalog:fixture-selected: Duplicate.")]),
        snapshot,
        nativeNames,
      ),
    ).toThrow();
  });

  test("rejects an unexpected unparsed entry instead of silently dropping it", () => {
    expect(() =>
      observeClaudeSkillPayload(
        payload([catalog("- fixture-catalog:fixture-selected: Good.\n- fixture-catalog:fixture-denied")]),
        snapshot,
        nativeNames,
      ),
    ).toThrow();
  });

  test("rejects an empty catalog marker because the native empty representation omits the block", () => {
    expect(() => observeClaudeSkillPayload(payload([catalog("")]), emptySnapshot, {})).toThrow();
  });

  test("rejects ambiguous native-to-canonical mappings", () => {
    expect(() =>
      observeClaudeSkillPayload(payload([catalog()]), snapshot, {
        "fixture/unused": "fixture-catalog:fixture-selected",
        ...nativeNames,
      }),
    ).toThrow();
  });

  test.each([
    ["missing messages", {}],
    ["empty messages", { model: "fixture-model", max_tokens: 32, messages: [] }],
    [
      "invalid message role",
      { model: "fixture-model", max_tokens: 32, messages: [{ role: "system", content: "Fixture" }] },
    ],
    [
      "invalid text block",
      { model: "fixture-model", max_tokens: 32, messages: [{ role: "user", content: [{ type: "text", text: 7 }] }] },
    ],
    [
      "missing text",
      { model: "fixture-model", max_tokens: 32, messages: [{ role: "user", content: [{ type: "text" }] }] },
    ],
    ["missing model", { max_tokens: 32, messages: [{ role: "user", content: "Fixture" }] }],
    ["missing output limit", { model: "fixture-model", messages: [{ role: "user", content: "Fixture" }] }],
  ])("rejects malformed request shape: %s", (_name, request) => {
    expect(() => observeClaudeSkillPayload(encoder.encode(JSON.stringify(request)), emptySnapshot, {})).toThrow();
  });

  test("does not echo malformed payload bytes in errors", () => {
    let failure: Error | undefined;
    try {
      observeClaudeSkillPayload(encoder.encode('{"private_fixture_marker": broken'), emptySnapshot, {});
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).not.toContain("private_fixture_marker");
  });

  test("rejects invalid UTF-8 rather than silently replacing payload bytes", () => {
    expect(() => observeClaudeSkillPayload(new Uint8Array([0xc0, 0x80]), emptySnapshot, {})).toThrow();
  });
});

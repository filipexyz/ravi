import { describe, expect, test } from "bun:test";
import { inspectCodexSkillPrompt } from "./codex-skill-prompt.js";
import { buildSkillExposureText } from "./skill-exposure-text.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";

const snapshot: SkillPolicySnapshot = {
  contractVersion: 1,
  id: "fixture-snapshot",
  status: "empty",
  scope: { agentId: "fixture-agent", executionId: "fixture-execution", contextKey: "fixture-context" },
  revisions: { policy: "1", catalog: "1", permissions: "1", toolSurface: "1" },
  skills: [],
  provenance: {},
  diagnostics: [],
};

function body(developer: string, user = "Fixture prompt"): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: developer }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: user }] },
      ],
    }),
  );
}

describe("Codex effective skill announcement", () => {
  test("observes one central envelope from developer instructions", () => {
    expect(inspectCodexSkillPrompt(body(buildSkillExposureText(snapshot)), snapshot)).toEqual({
      snapshotId: snapshot.id,
      mode: "textual",
      advertisedIds: [],
      discoverableIds: [],
      evidence: "effective-prompt",
    });
  });

  test("rejects a native catalog block regardless of skill names", () => {
    expect(() =>
      inspectCodexSkillPrompt(
        body(
          `${buildSkillExposureText(snapshot)}\n<skills_instructions>\nNative fixture catalog\n</skills_instructions>`,
        ),
        snapshot,
      ),
    ).toThrow("Codex skill prompt");
  });

  test("does not use user-supplied text as evidence of the authorized developer catalog", () => {
    expect(() => inspectCodexSkillPrompt(body("No catalog", buildSkillExposureText(snapshot)), snapshot)).toThrow(
      "Codex skill prompt",
    );
    expect(
      inspectCodexSkillPrompt(
        body(buildSkillExposureText(snapshot), "<skills_instructions>Quoted user text</skills_instructions>"),
        snapshot,
      ).advertisedIds,
    ).toEqual([]);
  });

  test("rejects duplicate, changed and malformed effective announcements without exposing input", () => {
    const envelope = buildSkillExposureText(snapshot);
    expect(() => inspectCodexSkillPrompt(body(`${envelope}\n${envelope}`), snapshot)).toThrow("Codex skill prompt");
    expect(() => inspectCodexSkillPrompt(body(envelope.replace(snapshot.id, "other-fixture")), snapshot)).toThrow(
      "Codex skill prompt",
    );
    expect(() => inspectCodexSkillPrompt(new TextEncoder().encode("not-json fixture"), snapshot)).toThrow(
      "Codex skill prompt",
    );
  });
});

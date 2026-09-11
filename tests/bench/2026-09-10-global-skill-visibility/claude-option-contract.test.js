import { beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the SDK boundary is simulated. The provider and local discovery are real.
let capturedOptions;
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }) => {
    capturedOptions = options;
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        yield { type: "result", subtype: "success", session_id: "fixture-session" };
      },
    };
  },
}));

const { createClaudeRuntimeProvider } = await import("../../../src/runtime/claude-provider.js");

beforeEach(() => { capturedOptions = undefined; });

async function captureOptions(allowedSkills) {
  const cwd = mkdtempSync(join(tmpdir(), "ravi-claude-skill-options-"));
  const localSkill = join(cwd, ".claude", "skills", "fixture-local-denied");
  mkdirSync(localSkill, { recursive: true });
  await Bun.write(join(localSkill, "SKILL.md"), "---\nname: fixture-local-denied\ndescription: Harmless unselected local fixture.\n---\n");
  const session = createClaudeRuntimeProvider().startSession({
    cwd,
    model: "fixture-model",
    abortController: new AbortController(),
    systemPromptAppend: "",
    env: { RAVI_MODEL_BROKER_ACTIVE: "1" },
    allowedSkills,
    settingSources: ["project"],
    prompt: (async function* () {
      yield { type: "user", message: { role: "user", content: "Fixture" }, session_id: "", parent_tool_use_id: null };
    })(),
  });
  for await (const event of session.events) {
    if (event.type === "turn.failed") throw new Error(event.error);
  }
  expect(capturedOptions).toBeDefined();
  return capturedOptions;
}

test("an explicitly empty snapshot stays empty at the SDK boundary", async () => {
  const options = await captureOptions([]);
  expect(options.skills).toEqual([]);
});

test("native project skills do not expand an explicitly selected set", async () => {
  const options = await captureOptions(["fixture-allowed"]);
  expect(options.skills).toEqual(["fixture-allowed"]);
});

test("an explicitly admitted local skill is preserved exactly once", async () => {
  const options = await captureOptions(["fixture-local-denied"]);
  expect(options.skills).toEqual(["fixture-local-denied"]);
});

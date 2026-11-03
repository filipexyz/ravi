import { describe, expect, test } from "bun:test";

import { BUG_TRIAGE_SCHEMA_VERSION } from "./bug-reports";
import {
  DEFAULT_BUG_TRIAGE_MODEL,
  isBugTriageEngineConfigured,
  readBugTriageEngineConfig,
} from "./bug-triage-config";
import {
  BugTriageEngineError,
  bugTriageChatCompletionsUrl,
  completeBugTriageSuggestion,
  extractChatCompletionText,
  parseModelTriageOutput,
} from "./bug-triage-engine";

const SAMPLE = {
  schemaVersion: BUG_TRIAGE_SCHEMA_VERSION,
  model: "qwen3.8-27b",
  summary: "Likely a watch arming race.",
  suggestedPriority: "p1",
  suggestedStatus: "triaging",
  similarBugIds: [],
  missingEvidence: ["daemon logs"],
  clarifyingQuestions: ["Does it reproduce on main?"],
  confidence: 0.7,
};

describe("bug triage engine config", () => {
  test("fails closed unless both base URL and API key are set", () => {
    expect(isBugTriageEngineConfigured({})).toBe(false);
    expect(isBugTriageEngineConfigured({ RAVI_BUG_TRIAGE_API_BASE: "https://models.example/v1" })).toBe(false);
    expect(isBugTriageEngineConfigured({ RAVI_BUG_TRIAGE_API_KEY: "secret" })).toBe(false);
    expect(
      readBugTriageEngineConfig({
        RAVI_BUG_TRIAGE_API_BASE: "https://models.example/v1/",
        RAVI_BUG_TRIAGE_API_KEY: "secret",
      }),
    ).toEqual({
      apiBase: "https://models.example/v1",
      apiKey: "secret",
      model: DEFAULT_BUG_TRIAGE_MODEL,
    });
  });

  test("builds an OpenAI-compatible chat completions URL", () => {
    expect(bugTriageChatCompletionsUrl("https://models.example/v1")).toBe("https://models.example/v1/chat/completions");
    expect(bugTriageChatCompletionsUrl("https://models.example/v1/chat/completions")).toBe(
      "https://models.example/v1/chat/completions",
    );
  });
});

describe("bug triage model parse", () => {
  test("accepts fenced JSON and drops invented similar ids", () => {
    const parsed = parseModelTriageOutput({
      model: "qwen3.8-27b",
      text: `here you go\n\`\`\`json\n${JSON.stringify({
        ...SAMPLE,
        similarBugIds: ["not-a-uuid", "22222222-2222-4222-8222-222222222222"],
      })}\n\`\`\``,
    });
    expect(parsed.schemaVersion).toBe(BUG_TRIAGE_SCHEMA_VERSION);
    expect(parsed.suggestedPriority).toBe("p1");
    expect(parsed.similarBugIds).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  test("rejects invalid model documents", () => {
    expect(() => parseModelTriageOutput({ model: "qwen3.8-27b", text: "not json" })).toThrow(BugTriageEngineError);
    expect(() =>
      parseModelTriageOutput({
        model: "qwen3.8-27b",
        text: JSON.stringify({ ...SAMPLE, suggestedPriority: "p9" }),
      }),
    ).toThrow();
  });

  test("reads OpenAI chat completion text", () => {
    expect(
      extractChatCompletionText({
        choices: [{ message: { content: JSON.stringify(SAMPLE) } }],
      }),
    ).toContain("ravi.bug_triage/v1");
  });
});

describe("bug triage model complete", () => {
  test("does not invent a provider host when config is missing", async () => {
    try {
      await completeBugTriageSuggestion({
        env: {},
        report: {
          title: "x",
          summary: "y",
          severity: "low",
          surface: "cli",
          payload: {},
        },
        fetchImpl: async () => {
          throw new Error("fetch should not run");
        },
      });
      throw new Error("expected unconfigured engine");
    } catch (error) {
      expect(error).toBeInstanceOf(BugTriageEngineError);
      expect((error as BugTriageEngineError).code).toBe("triage_engine_not_configured");
    }
  });

  test("parses a hosted chat completion without applying product fields", async () => {
    const triage = await completeBugTriageSuggestion({
      env: {
        RAVI_BUG_TRIAGE_API_BASE: "https://models.example/v1",
        RAVI_BUG_TRIAGE_API_KEY: "secret",
      },
      report: {
        title: "CLI watch never arms",
        summary: "Creating a GitHub watch returns 200 but no events arrive.",
        severity: "high",
        surface: "cli",
        payload: { steps: "ravi watches create" },
      },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://models.example/v1/chat/completions");
        const body = JSON.parse(String(init && "body" in init ? init.body : "{}"));
        expect(body.model).toBe(DEFAULT_BUG_TRIAGE_MODEL);
        expect(body.messages[0].content).toContain("You only suggest");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(SAMPLE) } }] }),
          { status: 200 },
        );
      },
    });
    expect(triage.suggestedPriority).toBe("p1");
    expect(triage).not.toHaveProperty("priority");
    expect(triage).not.toHaveProperty("status");
  });
});

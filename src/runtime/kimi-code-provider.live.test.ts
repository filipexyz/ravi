import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKimiCodeRuntimeProvider } from "./kimi-code-provider.js";
import type { RuntimeEvent, RuntimePromptMessage, RuntimeStartRequest } from "./types.js";

const LIVE_TIMEOUT_MS = 180_000;
const liveEnabled = process.env.RAVI_LIVE_TESTS === "1";
const kimiSessionStartEnabled = process.env.RAVI_KIMI_CODE_ENABLED === "1";
// Freshness is an operator-controlled private-channel requirement; never inspect or
// print the key here. A blank value is not a credential.
const hasFreshKimiMembershipKey = Boolean(process.env.KIMI_API_KEY?.trim());
const liveIt = liveEnabled && kimiSessionStartEnabled && hasFreshKimiMembershipKey ? it : it.skip;

function prompt(messages: string[]): AsyncGenerator<RuntimePromptMessage> {
  return (async function* () {
    for (const content of messages) {
      yield {
        type: "user",
        message: { role: "user", content },
        session_id: "",
        parent_tool_use_id: null,
      };
    }
  })();
}

function request(cwd: string, messages: string[]): RuntimeStartRequest {
  return {
    prompt: prompt(messages),
    model: process.env.RAVI_LIVE_KIMI_CODE_MODEL ?? "k3",
    cwd,
    abortController: new AbortController(),
    systemPromptAppend: "Automated integration test. Follow the request exactly.",
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    settingSources: ["project"],
  };
}

function redactedFailureClassification(event: Extract<RuntimeEvent, { type: "turn.failed" }>): string {
  // Provider projections may expose only bounded classification keys. Do not read or
  // retain their values: bodies, headers, prompts, and account identifiers are out
  // of scope for a public live-test artifact.
  const keys = Object.keys(event.rawEvent ?? {}).sort();
  expect(keys.every((key) => ["preflight", "protocol", "transport"].includes(key))).toBe(true);
  return keys.length === 0 ? "redacted" : "classified";
}

async function collectStructuralEvents(events: AsyncIterable<RuntimeEvent>): Promise<{
  types: RuntimeEvent["type"][];
  failureClassifications: string[];
}> {
  const types: RuntimeEvent["type"][] = [];
  const failureClassifications: string[] = [];

  for await (const event of events) {
    types.push(event.type);
    if (event.type === "turn.failed") failureClassifications.push(redactedFailureClassification(event));
  }

  return { types, failureClassifications };
}

function expectCompletedTurnSequence(types: RuntimeEvent["type"][]): void {
  expect(types.filter((type) => type === "thread.started")).toHaveLength(1);
  expect(types.filter((type) => type === "turn.started")).toHaveLength(1);
  expect(types.filter((type) => type === "turn.complete")).toHaveLength(1);
  expect(types.filter((type) => type === "turn.failed" || type === "turn.interrupted")).toHaveLength(0);
  expect(types.at(-1)).toBe("turn.complete");
}

describe("kimi-code live runtime", () => {
  liveIt(
    "emits one redacted structural terminal sequence",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ravi-live-kimi-code-"));
      try {
        const session = createKimiCodeRuntimeProvider().startSession(request(cwd, ["Reply with OK."]));
        const result = await collectStructuralEvents(session.events);

        expect(result.failureClassifications).toHaveLength(0);
        expectCompletedTurnSequence(result.types);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );

  liveIt(
    "emits two redacted structural terminal sequences for continuation",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ravi-live-kimi-code-"));
      try {
        const session = createKimiCodeRuntimeProvider().startSession(
          request(cwd, ["Reply with OK.", "Reply with OK again."]),
        );
        const result = await collectStructuralEvents(session.events);

        expect(result.failureClassifications).toHaveLength(0);
        expect(result.types.filter((type) => type === "thread.started")).toHaveLength(1);
        expect(result.types.filter((type) => type === "turn.started")).toHaveLength(2);
        expect(result.types.filter((type) => type === "turn.complete")).toHaveLength(2);
        expect(result.types.filter((type) => type === "turn.failed" || type === "turn.interrupted")).toHaveLength(0);
        expect(result.types.at(-1)).toBe("turn.complete");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

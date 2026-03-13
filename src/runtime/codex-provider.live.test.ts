import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexRuntimeProvider } from "./codex-provider.js";
import { registerLiveProviderSuite } from "./live-test-helpers.js";
import type { RuntimeEvent, RuntimePromptMessage, RuntimeStartRequest } from "./types.js";

const LIVE_TIMEOUT_MS = 180_000;
const liveEnabled = process.env.RAVI_LIVE_TESTS === "1";
const canRunCodexLive = liveEnabled && hasCodexCli();

registerLiveProviderSuite({
  providerId: "codex",
  enabled: canRunCodexLive,
  model: process.env.RAVI_LIVE_CODEX_MODEL ?? process.env.RAVI_CODEX_MODEL ?? "gpt-5",
  createProvider: () => createCodexRuntimeProvider(),
});

const liveIt = canRunCodexLive ? it : it.skip;

describe("codex live runtime tool bridge", () => {
  liveIt(
    "emits real text deltas through the app-server transport",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ravi-live-codex-delta-"));
      try {
        const provider = createCodexRuntimeProvider();
        const request = await buildStartRequest(provider, cwd, ["Write exactly 4 short numbered lines about pears."]);

        const session = provider.startSession(request);
        const events = await collectEvents(session.events);
        const deltas = events.filter(
          (event): event is Extract<RuntimeEvent, { type: "text.delta" }> => event.type === "text.delta",
        );
        const assistantMessages = events
          .filter(
            (event): event is Extract<RuntimeEvent, { type: "assistant.message" }> =>
              event.type === "assistant.message",
          )
          .map((event) => event.text)
          .join("\n");

        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.map((event) => event.text).join("")).toContain("1.");
        expect(assistantMessages).toContain("1.");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );

  liveIt(
    "emits real shell tool lifecycle events",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "ravi-live-codex-tools-"));
      try {
        const provider = createCodexRuntimeProvider();
        const request = await buildStartRequest(provider, cwd, [
          "Run the shell command pwd and then reply with exactly the directory path only.",
        ]);

        const session = provider.startSession(request);
        const events = await collectEvents(session.events);
        const toolStarts = events.filter(
          (event): event is Extract<RuntimeEvent, { type: "tool.started" }> => event.type === "tool.started",
        );
        const toolCompleted = events.filter(
          (event): event is Extract<RuntimeEvent, { type: "tool.completed" }> => event.type === "tool.completed",
        );
        const assistantMessages = events
          .filter(
            (event): event is Extract<RuntimeEvent, { type: "assistant.message" }> =>
              event.type === "assistant.message",
          )
          .map((event) => event.text);
        const turns = events.filter(
          (event): event is Extract<RuntimeEvent, { type: "turn.complete" }> => event.type === "turn.complete",
        );

        expect(turns).toHaveLength(1);
        expect(toolStarts.some((event) => event.toolUse.name === "shell")).toBe(true);
        expect(toolCompleted.some((event) => event.toolName === "shell")).toBe(true);
        expect(assistantMessages.join("\n").toLowerCase()).toContain(cwd.toLowerCase());
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

async function buildStartRequest(
  provider: ReturnType<typeof createCodexRuntimeProvider>,
  cwd: string,
  messages: string[],
): Promise<RuntimeStartRequest> {
  const bootstrap = await provider.prepareSession?.({
    agentId: "live-test",
    cwd,
  });

  return {
    prompt: createPromptGenerator(messages),
    model: process.env.RAVI_LIVE_CODEX_MODEL ?? process.env.RAVI_CODEX_MODEL ?? "gpt-5",
    cwd,
    abortController: new AbortController(),
    systemPromptAppend: "You are running inside an automated integration test. Follow formatting instructions exactly.",
    env: {
      ...getStringEnv(),
      ...(bootstrap?.env ?? {}),
    },
    settingSources: ["project"],
  };
}

function createPromptGenerator(messages: string[]): AsyncGenerator<RuntimePromptMessage> {
  return (async function* () {
    for (const message of messages) {
      yield {
        type: "user",
        message: {
          role: "user",
          content: message,
        },
        session_id: "",
        parent_tool_use_id: null,
      };
    }
  })();
}

async function collectEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const output: RuntimeEvent[] = [];
  for await (const event of events) {
    output.push(event);
  }
  return output;
}

function getStringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function hasCodexCli(): boolean {
  const version = spawnSync("codex", ["--version"], { stdio: "ignore" });
  if (version.status !== 0) {
    return false;
  }

  if (process.env.OPENAI_API_KEY) {
    return true;
  }

  return existsSync(join(homedir(), ".codex", "auth.json"));
}

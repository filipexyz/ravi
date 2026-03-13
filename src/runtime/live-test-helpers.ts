import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RuntimeEvent,
  RuntimeProviderId,
  RuntimePromptMessage,
  RuntimeStartRequest,
  SessionRuntimeProvider,
} from "./types.js";

const LIVE_TIMEOUT_MS = 180_000;

interface CollectedTurn {
  terminal: "turn.complete" | "turn.failed" | "turn.interrupted";
  assistantText: string;
  streamedText: string;
  providerSessionId?: string;
  error?: string;
}

export interface LiveProviderSuiteOptions {
  providerId: RuntimeProviderId;
  enabled: boolean;
  model: string;
  createProvider: () => SessionRuntimeProvider;
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

function getStringEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function buildStartRequest(
  provider: SessionRuntimeProvider,
  cwd: string,
  model: string,
  messages: string[],
): Promise<RuntimeStartRequest> {
  const bootstrap = await provider.prepareSession?.({
    agentId: "live-test",
    cwd,
  });

  return {
    prompt: createPromptGenerator(messages),
    model,
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

async function collectTurns(events: AsyncIterable<RuntimeEvent>): Promise<CollectedTurn[]> {
  const turns: CollectedTurn[] = [];
  let assistantText = "";
  let streamedText = "";

  for await (const event of events) {
    if (event.type === "assistant.message") {
      assistantText += event.text;
    } else if (event.type === "text.delta") {
      streamedText += event.text;
    } else if (event.type === "turn.complete") {
      turns.push({
        terminal: "turn.complete",
        assistantText: assistantText.trim(),
        streamedText: streamedText.trim(),
        providerSessionId: event.providerSessionId,
      });
      assistantText = "";
      streamedText = "";
    } else if (event.type === "turn.failed") {
      turns.push({
        terminal: "turn.failed",
        assistantText: assistantText.trim(),
        streamedText: streamedText.trim(),
        error: event.error,
      });
      assistantText = "";
      streamedText = "";
    } else if (event.type === "turn.interrupted") {
      turns.push({
        terminal: "turn.interrupted",
        assistantText: assistantText.trim(),
        streamedText: streamedText.trim(),
      });
      assistantText = "";
      streamedText = "";
    }
  }

  return turns;
}

function getTurnText(turn: CollectedTurn): string {
  return (turn.assistantText || turn.streamedText).trim();
}

export function registerLiveProviderSuite(options: LiveProviderSuiteOptions): void {
  const liveIt = options.enabled ? it : it.skip;

  describe(`${options.providerId} live runtime`, () => {
    liveIt(
      "completes a real prompt round-trip",
      async () => {
        const cwd = mkdtempSync(join(tmpdir(), `ravi-live-${options.providerId}-`));
        try {
          const provider = options.createProvider();
          const marker = `RAVI_${options.providerId.toUpperCase()}_LIVE_OK`;
          const request = await buildStartRequest(provider, cwd, options.model, [
            `Reply with exactly ${marker} and nothing else.`,
          ]);

          const session = provider.startSession(request);
          const turns = await collectTurns(session.events);

          expect(turns).toHaveLength(1);
          expect(turns[0]?.terminal).toBe("turn.complete");
          expect(getTurnText(turns[0]!)).toContain(marker);
          expect(turns[0]?.providerSessionId).toBeTruthy();
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      LIVE_TIMEOUT_MS,
    );

    liveIt(
      "preserves conversation context across turns",
      async () => {
        const cwd = mkdtempSync(join(tmpdir(), `ravi-live-${options.providerId}-`));
        try {
          const provider = options.createProvider();
          const token = `RAVI_${options.providerId.toUpperCase()}_TOKEN_74219`;
          const request = await buildStartRequest(provider, cwd, options.model, [
            `Remember this token for later: ${token}. Reply with exactly ACK_TOKEN and nothing else.`,
            "What token did I ask you to remember earlier in this conversation? Reply with exactly the token and nothing else.",
          ]);

          const session = provider.startSession(request);
          const turns = await collectTurns(session.events);

          expect(turns).toHaveLength(2);
          expect(turns[0]?.terminal).toBe("turn.complete");
          expect(getTurnText(turns[0]!)).toContain("ACK_TOKEN");
          expect(turns[1]?.terminal).toBe("turn.complete");
          expect(getTurnText(turns[1]!)).toContain(token);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      },
      LIVE_TIMEOUT_MS,
    );
  });
}

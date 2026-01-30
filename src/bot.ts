import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Notif } from "notif.sh";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";
import {
  loadRouterConfig,
  getOrCreateSession,
  updateSdkSessionId,
  updateTokens,
  closeSessions,
  expandHome,
  type RouterConfig,
  type SessionEntry,
} from "./router/index.js";

const log = logger.child("bot");

/** Message routing target */
export interface MessageTarget {
  channel: string;
  accountId: string;
  chatId: string;
}

/** Prompt message structure */
export interface PromptMessage {
  prompt: string;
  source?: MessageTarget;
}

/** Response message structure */
export interface ResponseMessage {
  response?: string;
  error?: string;
  target?: MessageTarget;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface RaviBotOptions {
  config: Config;
}

export class RaviBot {
  private config: Config;
  private routerConfig: RouterConfig;
  private notif: Notif;
  private running = false;

  constructor(options: RaviBotOptions) {
    this.config = options.config;
    this.routerConfig = loadRouterConfig();
    this.notif = new Notif();
    logger.setLevel(options.config.logLevel);
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...");
    this.running = true;
    this.subscribeToPrompts();
    log.info("Ravi bot started", {
      agents: Object.keys(this.routerConfig.agents),
    });
  }

  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;
    this.notif.close();
    closeDb();
    closeSessions();
    log.info("Ravi bot stopped");
  }

  private async subscribeToPrompts(): Promise<void> {
    const topic = "ravi.*.prompt";
    log.info(`Subscribing to ${topic}`);

    try {
      for await (const event of this.notif.subscribe(topic)) {
        if (!this.running) break;

        try {
          // Extract session key from topic: ravi.{sessionKey}.prompt
          const sessionKey = event.topic.split(".").slice(1, -1).join(".");
          const prompt = event.data as unknown as PromptMessage;

          await this.handlePrompt(sessionKey, prompt);
        } catch (err) {
          log.error("Failed to handle prompt", err);
        }
      }
    } catch (err) {
      log.error("Subscription error", err);
      if (this.running) {
        setTimeout(() => this.subscribeToPrompts(), 1000);
      }
    }
  }

  private async handlePrompt(sessionKey: string, prompt: PromptMessage): Promise<void> {
    // Parse session key to get agent ID: "agent:main:..." -> "main"
    const parts = sessionKey.split(":");
    const agentId = parts[0] === "agent" ? parts[1] : this.routerConfig.defaultAgent;
    const agent = this.routerConfig.agents[agentId] ?? this.routerConfig.agents[this.routerConfig.defaultAgent];

    if (!agent) {
      log.error("No agent found", { sessionKey, agentId });
      return;
    }

    const agentCwd = expandHome(agent.cwd);
    const session = getOrCreateSession(sessionKey, agent.id, agentCwd);

    log.info("Received prompt", { sessionKey, agentId, agentCwd });

    // Save message
    saveMessage(sessionKey, "user", prompt.prompt);

    try {
      const response = await this.processPrompt(prompt, session, agent, agentCwd);

      if (response.response) {
        saveMessage(sessionKey, "assistant", response.response);
      }

      await this.notif.emit(`ravi.${sessionKey}.response`, response as Record<string, unknown>);
    } catch (err) {
      log.error("Query failed", err);
      await this.notif.emit(`ravi.${sessionKey}.response`, {
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  private async processPrompt(
    prompt: PromptMessage,
    session: SessionEntry,
    agent: { model?: string },
    agentCwd: string
  ): Promise<ResponseMessage> {
    let responseText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const model = agent.model ?? this.config.model;

    const queryResult = query({
      prompt: prompt.prompt,
      options: {
        model,
        maxTurns: 1,
        cwd: agentCwd,
        resume: session.sdkSessionId,
      },
    });

    for await (const message of queryResult) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText += block.text;
          }
        }
      }

      if (message.type === "result") {
        inputTokens = message.usage?.input_tokens ?? 0;
        outputTokens = message.usage?.output_tokens ?? 0;

        if ("session_id" in message && message.session_id) {
          updateSdkSessionId(session.sessionKey, message.session_id);
        }

        updateTokens(session.sessionKey, inputTokens, outputTokens);
      }
    }

    return {
      response: responseText.trim(),
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}

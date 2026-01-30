import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Notif } from "notif.sh";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";
import { buildDefaultPrompt } from "./prompt-builder.js";
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
      // Emit partial messages as they arrive
      const onMessage = async (text: string) => {
        const partialResponse: ResponseMessage = {
          response: text,
          target: prompt.source,
        };
        await this.notif.emit(`ravi.${sessionKey}.response`, partialResponse as Record<string, unknown>);
      };

      const response = await this.processPrompt(prompt, session, agent, agentCwd, onMessage);

      if (response.response) {
        saveMessage(sessionKey, "assistant", response.response);
      }

      // Final response with usage (not sent to channel, just for tracking)
      if (response.usage) {
        log.info("Final usage", response.usage);
      }
    } catch (err) {
      log.error("Query failed", err);
      const errorResponse: ResponseMessage = {
        error: err instanceof Error ? err.message : "Unknown error",
        target: prompt.source,
      };
      await this.notif.emit(`ravi.${sessionKey}.response`, errorResponse as Record<string, unknown>);
    }
  }

  private async processPrompt(
    prompt: PromptMessage,
    session: SessionEntry,
    agent: { model?: string },
    agentCwd: string,
    onMessage?: (text: string) => Promise<void>
  ): Promise<ResponseMessage> {
    let responseText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const model = agent.model ?? this.config.model;

    const queryResult = query({
      prompt: prompt.prompt,
      options: {
        model,
        cwd: agentCwd,
        resume: session.sdkSessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildDefaultPrompt(),
        },
        settingSources: ["project"],
      },
    });

    for await (const message of queryResult) {
      log.info("SDK message", { type: message.type });

      if (message.type === "assistant") {
        const blocks = message.message.content;
        let messageText = "";
        for (const block of blocks) {
          if (block.type === "text") {
            messageText += block.text;
          }
        }
        if (messageText) {
          log.info("Assistant message", { text: messageText.slice(0, 100) });
          responseText += messageText;
          if (onMessage) {
            await onMessage(messageText);
          }
        }
      }

      if (message.type === "result") {
        inputTokens = message.usage?.input_tokens ?? 0;
        outputTokens = message.usage?.output_tokens ?? 0;
        log.info("Result", { inputTokens, outputTokens, sessionId: message.session_id });

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

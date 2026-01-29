import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Notif } from "notif.sh";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";

const log = logger.child("bot");

/** Prompt message structure */
export interface PromptMessage {
  prompt: string;
}

/** Response message structure */
export interface ResponseMessage {
  response?: string;
  error?: string;
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
  private notif: Notif;
  private hasHistory = false;
  private running = false;

  constructor(options: RaviBotOptions) {
    this.config = options.config;
    this.notif = new Notif();
    logger.setLevel(options.config.logLevel);
  }

  /**
   * Start the bot and begin listening for prompts.
   */
  async start(): Promise<void> {
    log.info("Starting Ravi bot...");

    this.running = true;
    this.subscribeToPrompts();

    log.info("Ravi bot started successfully");
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;
    this.notif.close();
    closeDb();
    log.info("Ravi bot stopped");
  }

  /**
   * Subscribe to ravi.*.prompt topic.
   */
  private async subscribeToPrompts(): Promise<void> {
    const topic = "ravi.*.prompt";
    log.info(`Subscribing to ${topic}`);

    try {
      for await (const event of this.notif.subscribe(topic)) {
        if (!this.running) break;

        try {
          await this.handlePromptEvent({
            topic: event.topic,
            data: event.data as unknown as PromptMessage,
          });
        } catch (err) {
          log.error("Failed to handle prompt event", err);
        }
      }
    } catch (err) {
      log.error("Subscription error", err);
      if (this.running) {
        setTimeout(() => this.subscribeToPrompts(), 1000);
      }
    }
  }

  /**
   * Handle an incoming prompt event.
   */
  private async handlePromptEvent(event: {
    topic: string;
    data: PromptMessage;
  }): Promise<void> {
    const { topic, data: prompt } = event;

    // Extract session ID from topic (ravi.{session}.prompt)
    const topicParts = topic.split(".");
    const sessionId = topicParts[1] || "main";

    log.info(`Received prompt`, { sessionId, topic });
    await this.debug(sessionId, "prompt_received", { prompt: prompt.prompt });

    // Save user message
    saveMessage(sessionId, "user", prompt.prompt);

    try {
      await this.debug(sessionId, "query_start");
      const response = await this.processPrompt(prompt, sessionId);
      await this.debug(sessionId, "query_complete", {
        usage: response.usage,
        responseLen: response.response?.length,
      });

      // Save assistant response
      if (response.response) {
        saveMessage(sessionId, "assistant", response.response);
      }

      await this.emitResponse(sessionId, response);
    } catch (err) {
      log.error("Failed to process prompt", err);
      await this.debug(sessionId, "query_error", {
        error: err instanceof Error ? err.message : "Unknown",
      });
      const errorResponse: ResponseMessage = {
        error: err instanceof Error ? err.message : "Unknown error",
      };
      await this.emitResponse(sessionId, errorResponse);
    }
  }

  /**
   * Process a prompt using the Claude Agent SDK.
   */
  private async processPrompt(
    prompt: PromptMessage,
    sessionId: string
  ): Promise<ResponseMessage> {
    let responseText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const queryResult = query({
        prompt: prompt.prompt,
        options: {
          model: this.config.model,
          maxTurns: 1,
          continue: this.hasHistory,
        },
      });

      for await (const message of queryResult) {
        await this.debug(sessionId, "sdk_message", { type: message.type });

        this.processMessage(message, (text) => {
          responseText += text;
        });

        if (message.type === "result") {
          inputTokens = message.usage?.input_tokens ?? 0;
          outputTokens = message.usage?.output_tokens ?? 0;
          this.hasHistory = true;
        }
      }
    } catch (err) {
      log.error("Query failed", err);
      throw err;
    }

    return {
      response: responseText.trim(),
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    };
  }

  /**
   * Process an SDK message and extract relevant info.
   */
  private processMessage(
    message: SDKMessage,
    onText: (text: string) => void
  ): void {
    switch (message.type) {
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "text") {
            onText(block.text);
          }
        }
        break;

      case "result":
        log.debug("Query completed", {
          subtype: message.subtype,
          cost: message.total_cost_usd,
        });
        break;
    }
  }

  /**
   * Emit a response to the ravi.{session}.response topic.
   */
  private async emitResponse(
    sessionId: string,
    response: ResponseMessage
  ): Promise<void> {
    const topic = `ravi.${sessionId}.response`;
    await this.emit(topic, response);
  }

  /**
   * Emit an event to a topic.
   */
  private async emit(topic: string, data: unknown): Promise<void> {
    try {
      await this.notif.emit(topic, data as Record<string, unknown>);
    } catch (err) {
      log.error(`Failed to emit to ${topic}`, err);
    }
  }

  /**
   * Emit a debug event.
   */
  private async debug(sessionId: string, event: string, data?: unknown): Promise<void> {
    await this.emit(`ravi.${sessionId}.debug`, {
      event,
      data: data ?? null,
      ts: Date.now(),
    });
  }
}

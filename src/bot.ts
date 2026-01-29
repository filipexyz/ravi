import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, close as closeDb } from "./db.js";

const execAsync = promisify(exec);
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
  private hasHistory = false;
  private subscriptionProcess: ReturnType<typeof spawn> | null = null;
  private running = false;

  constructor(options: RaviBotOptions) {
    this.config = options.config;
    logger.setLevel(options.config.logLevel);
  }

  /**
   * Start the bot and begin listening for prompts.
   */
  async start(): Promise<void> {
    log.info("Starting Ravi bot...");

    // Subscribe to prompt topic
    this.running = true;
    await this.subscribeToPrompts();

    log.info("Ravi bot started successfully");
  }

  /**
   * Stop the bot gracefully.
   */
  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;

    if (this.subscriptionProcess) {
      this.subscriptionProcess.kill();
      this.subscriptionProcess = null;
    }

    closeDb();
    log.info("Ravi bot stopped");
  }

  /**
   * Subscribe to ravi.*.prompt topic using notif CLI.
   */
  private async subscribeToPrompts(): Promise<void> {
    const topic = "ravi.*.prompt";
    log.info(`Subscribing to ${topic}`);

    // Use notif subscribe command
    this.subscriptionProcess = spawn("notif", ["subscribe", topic, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.subscriptionProcess.stdout?.on("data", async (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          await this.handlePromptEvent(event);
        } catch (err) {
          log.error("Failed to parse prompt event", { line, err });
        }
      }
    });

    this.subscriptionProcess.stderr?.on("data", (data: Buffer) => {
      log.warn("notif stderr", { output: data.toString() });
    });

    this.subscriptionProcess.on("close", (code) => {
      log.info(`notif subscribe process exited with code ${code}`);
      if (this.running) {
        // Reconnect after a delay
        setTimeout(() => this.subscribeToPrompts(), 1000);
      }
    });
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

    // Save user message
    saveMessage(sessionId, "user", prompt.prompt);

    try {
      const response = await this.processPrompt(prompt);
      // Save assistant response
      if (response.response) {
        saveMessage(sessionId, "assistant", response.response);
      }
      await this.emitResponse(sessionId, response);
    } catch (err) {
      log.error("Failed to process prompt", err);
      const errorResponse: ResponseMessage = {
        error: err instanceof Error ? err.message : "Unknown error",
      };
      await this.emitResponse(sessionId, errorResponse);
    }
  }

  /**
   * Process a prompt using the Claude Agent SDK.
   */
  private async processPrompt(prompt: PromptMessage): Promise<ResponseMessage> {
    // Collect response
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

      // Process streaming messages
      for await (const message of queryResult) {
        this.processMessage(message, (text) => {
          responseText += text;
        });

        // Extract usage from result messages
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
        // Extract text from content blocks
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
    const payload = JSON.stringify(response);

    log.debug(`Emitting response to ${topic}`);

    try {
      await execAsync(
        `echo '${payload.replace(/'/g, "'\\''")}' | notif emit '${topic}'`
      );
    } catch (err) {
      log.error("Failed to emit response", err);
    }
  }
}

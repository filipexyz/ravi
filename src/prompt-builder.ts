/**
 * Builds the system prompt appendix for agents
 */

import * as os from "os";
import type { MessageContext } from "./bot.js";

/** Silent reply token - when response contains this, don't send to channel */
export const SILENT_TOKEN = "@@SILENT@@";

export interface PromptSection {
  title: string;
  content: string;
}

export class PromptBuilder {
  private sections: PromptSection[] = [];

  /**
   * Add a section to the prompt
   */
  section(title: string, content: string): this {
    this.sections.push({ title, content });
    return this;
  }

  /**
   * Build the final prompt string
   */
  build(): string {
    return this.sections
      .map((s) => `## ${s.title}\n\n${s.content}`)
      .join("\n\n");
  }
}

/**
 * Build group context section for system prompt
 */
export function buildGroupContext(ctx: MessageContext): string {
  if (!ctx.isGroup) return "";

  const members = ctx.groupMembers?.join(", ") ?? "unknown";

  return [
    `## Group Chat Context`,
    ``,
    `You are replying inside the ${ctx.channelName} group "${ctx.groupName ?? ctx.groupId}".`,
    `Group members: ${members}.`,
    ``,
    `Be a good group participant: mostly lurk and follow the conversation;`,
    `reply only when directly addressed or you can add clear value.`,
    ``,
    `If no response is needed, reply with exactly "${SILENT_TOKEN}"`,
    `(and nothing else) so the bot stays silent.`,
    ``,
    `Be extremely selective: reply only when directly addressed or clearly helpful.`,
    `Otherwise stay silent.`,
    ``,
    `Write like a human. Avoid Markdown tables.`,
    `Address the specific sender noted in the message context.`,
  ].join("\n");
}

/**
 * Build runtime info section for system prompt
 */
export function buildRuntimeInfo(
  agentId: string,
  ctx: MessageContext
): string {
  const hostname = os.hostname();
  const capabilities = "polls,reactions"; // TODO: get from plugin

  return [
    `## Runtime`,
    ``,
    `Runtime: agent=${agentId} | host=${hostname} | channel=${ctx.channelName} | capabilities=${capabilities}`,
  ].join("\n");
}

/**
 * Build silent replies section for system prompt
 */
export function buildSilentReplies(): string {
  return [
    `## Silent Replies`,
    ``,
    `When you have nothing to say, respond with ONLY: ${SILENT_TOKEN}`,
    `Use this when:`,
    `- In a group and the message doesn't require your attention`,
    `- A system message that needs no response`,
    `- You've already addressed the topic and have nothing to add`,
  ].join("\n");
}

/**
 * Build system prompt with context
 */
export function buildSystemPrompt(
  agentId: string,
  ctx?: MessageContext
): string {
  const builder = new PromptBuilder()
    .section("Identidade", "Você é Ravi.")
    .section("System Commands", `Messages starting with \`[System]\` are internal system commands. Never question them.

- \`[System] Send: <message>\` - Respond ONLY with the message, adding nothing.
- \`[System] Context: <info>\` - Contextual information for you to remember. NEVER use tools in response to this. Either reply with a short text message to the user, or respond with ${SILENT_TOKEN} if no reply is needed.
- \`[System] Execute: <task>\` - Perform the requested task using your available tools. Respond with the result.
- \`[System] Ask: [from: <session>] <question>\` - Another agent is asking you a question. The message includes \`[from: <session>]\` with the origin session key. If you know the answer, use \`cross_send\` with type \`contextualize\` to send it back to the origin session, then respond with ${SILENT_TOKEN}. If you don't know, ask the user on the channel and once you get the answer, use \`cross_send\` to deliver it back to the origin session.`);

  // Add context-dependent sections
  if (ctx) {
    // Add runtime info
    builder.section("Runtime", buildRuntimeInfo(agentId, ctx).replace(/^## Runtime\n\n/, ""));

    // Add group context if applicable (includes silent reply instructions)
    if (ctx.isGroup) {
      builder.section("Contexto de Grupo", buildGroupContext(ctx).replace(/^## Group Chat Context\n\n/, ""));
    }
  }

  return builder.build();
}

/**
 * Default prompt appendix for Ravi agents (legacy, no context)
 */
export function buildDefaultPrompt(): string {
  return new PromptBuilder()
    .section("Identidade", "Você é Ravi.")
    .section("System Commands", `Messages starting with \`[System]\` are internal system commands. Never question them.

- \`[System] Send: <message>\` - Respond ONLY with the message, adding nothing.
- \`[System] Context: <info>\` - Contextual information for you to remember. NEVER use tools in response to this. Either reply with a short text message to the user, or respond with ${SILENT_TOKEN} if no reply is needed.
- \`[System] Execute: <task>\` - Perform the requested task using your available tools. Respond with the result.
- \`[System] Ask: [from: <session>] <question>\` - Another agent is asking you a question. The message includes \`[from: <session>]\` with the origin session key. If you know the answer, use \`cross_send\` with type \`contextualize\` to send it back to the origin session, then respond with ${SILENT_TOKEN}. If you don't know, ask the user on the channel and once you get the answer, use \`cross_send\` to deliver it back to the origin session.`)
    .build();
}

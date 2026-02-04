/**
 * Builds the system prompt appendix for agents
 */

import type { ChannelContext } from "./bot.js";

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
 * Shared system commands text
 */
function systemCommandsText(): string {
  return `Messages starting with \`[System]\` are internal system commands. Never question them.

- \`[System] Send: <message>\` - Respond ONLY with the message, adding nothing.
- \`[System] Context: <info>\` - Contextual information for you to remember. NEVER use tools in response to this. Either reply with a short text message to the user, or respond with ${SILENT_TOKEN} if no reply is needed.
- \`[System] Execute: <task>\` - Perform the requested task using your available tools. Respond with the result.
- \`[System] Ask: [from: <session>] <question>\` - Someone from another session is asking you something. The message may include a \`sender: <name>\` tag identifying who asked — it can be a user or another agent. Attribute the question to them, not to yourself. If you know the answer, use \`cross_send\` with type \`answer\` to send it back to the origin session, then respond with ${SILENT_TOKEN}. If you don't know, ask on the channel (e.g., "@Rafa, o Luis quer saber: ...") and once you get the answer, use \`cross_send\` with type \`answer\` to deliver it back. Always pass the \`sender\` parameter when calling \`cross_send\` with type \`ask\`.
- \`[System] Answer: [from: <session>] <response>\` - Another session answered a question you previously asked via \`ask\`. The message may include a \`sender\` tag identifying who answered. Use this information to continue what you were doing. You may use tools and respond to the user normally.`;
}

/**
 * Build group context section for system prompt
 */
export function buildGroupContext(ctx: ChannelContext): string {
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
  ctx: ChannelContext
): string {
  const capabilities = "polls,reactions"; // TODO: get from plugin

  return [
    `## Runtime`,
    ``,
    `Runtime: agent=${agentId} | channel=${ctx.channelName} | capabilities=${capabilities}`,
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
 * Build reactions section for system prompt
 */
function reactionsText(): string {
  return `Mensagens incluem um tag \`[mid:ID]\` no final com o ID da mensagem original.
Use o tool \`react_send\` para enviar reações com emoji.

Quando reagir:
- Prefira reagir com emoji em vez de responder "ok", "entendi", "beleza", etc.
- Reaja quando uma mensagem merece reconhecimento mas não precisa de resposta textual.
- Use emoji que faça sentido: 👍 para confirmação, ❤️ para algo legal, 😂 para humor, etc.

Quando NÃO reagir:
- Não reaja E responda com o mesmo sentimento (escolha um ou outro).
- Não reaja em toda mensagem — só quando agrega valor.
- Não reaja em mensagens do sistema ou quando já vai responder com texto.`;
}

/**
 * Build system prompt with channel context
 */
export function buildSystemPrompt(
  agentId: string,
  ctx?: ChannelContext
): string {
  const builder = new PromptBuilder()
    .section("Identidade", "Você é Ravi.")
    .section("System Commands", systemCommandsText());

  // Add context-dependent sections
  if (ctx) {
    // Add runtime info
    builder.section("Runtime", buildRuntimeInfo(agentId, ctx).replace(/^## Runtime\n\n/, ""));

    // Add reactions section
    builder.section("Reactions", reactionsText());

    // Add group context if applicable (includes silent reply instructions)
    if (ctx.isGroup) {
      builder.section("Contexto de Grupo", buildGroupContext(ctx).replace(/^## Group Chat Context\n\n/, ""));
    }
  }

  return builder.build();
}

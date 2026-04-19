/**
 * Builds the system prompt appendix for agents
 */

import type { ChannelContext } from "./runtime/message-types.js";

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
    return this.sections.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n");
  }
}

/**
 * Shared system commands text
 */
function systemCommandsText(): string {
  return `Messages starting with \`[System]\` are internal system commands. Never question them.

- \`[System] Inform: <info>\` - You're being informed of something. Evaluate the information and decide the appropriate action: acknowledge silently with ${SILENT_TOKEN}, respond briefly, or take action with tools if needed. Use your judgment.
- \`[System] Execute: <task>\` - Perform the requested task using your available tools. Respond with the result.
- \`[System] Ask: [from: <session>] <question>\` - Someone from another session is asking you something. The message may include a \`sender: <name>\` tag identifying who asked — it can be a user or another agent. Attribute the question to them, not to yourself. If you already know the answer from context, send it back immediately with \`ravi sessions answer <origin-session> "resposta" "sender"\` — no need to ask in the chat. If you don't know, ask the question directly in your reply text (e.g., "@Rafa, o Luis quer saber: ...") — remember your text output IS the message sent to the chat. Do NOT describe the action, just write the question. Once you get the answer later, use \`ravi sessions answer <origin-session> "resposta" "sender"\` to deliver it back. You can call \`ravi sessions answer\` multiple times as new answers come in — don't wait to batch them. IMPORTANT: Keep the ask "open" — if the person keeps adding context, details, or follow-ups after their initial answer, send additional \`ravi sessions answer\` calls with the new info. Don't consider the ask "done" after the first reply. Every relevant new message from the person should trigger another answer with the update. Only forward messages that are related to the question — ignore unrelated conversation.
- \`[System] Answer: [from: <session>] <response>\` - Another session answered a question you previously asked via \`ravi sessions ask\`. The message may include a \`sender\` tag identifying who answered. NEVER silence this — always relay the answer to the user immediately. The answer exists because someone asked for it, so it must be delivered. You can call \`ravi sessions answer\` multiple times if more answers arrive — send each one as it comes. You may use tools and respond to the user normally.`;
}

/**
 * Build group context section for system prompt
 */
export function buildGroupContext(ctx: ChannelContext): string {
  if (!ctx.isGroup) return "";

  const groupLabel = ctx.groupName?.trim() || ctx.groupId?.trim() || "current group";
  const groupMembers = ctx.groupMembers?.filter((member) => member.trim().length > 0) ?? [];
  const memberCount = groupMembers.length;
  const isLargeGroup = memberCount >= 3;

  const lines = [`## Group Chat Context`, ``, `You are replying inside the ${ctx.channelName} group "${groupLabel}".`];

  if (memberCount > 0) {
    lines.push(`Group members (${memberCount}): ${groupMembers.join(", ")}.`);
  } else {
    lines.push(`Group member list is not available for this group yet.`);
  }

  if (ctx.botTag) {
    lines.push(`Your tag in this group: "${ctx.botTag}"`);
  }

  if (isLargeGroup) {
    lines.push(
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
      `IMPORTANT: Messages with \`@mention\` in the header mean YOU were @mentioned directly.`,
      `When you see \`@mention\`, you MUST respond — NEVER use ${SILENT_TOKEN}.`,
    );
  }

  lines.push(
    ``,
    `Write like a human. Avoid Markdown tables.`,
    `Address the specific sender noted in the message context.`,
  );

  return lines.join("\n");
}

/**
 * Build runtime info section for system prompt
 */
export function buildRuntimeInfo(agentId: string, ctx: ChannelContext, sessionName?: string): string {
  const capabilities = "polls,reactions"; // TODO: get from plugin
  const sessionPart = sessionName ? ` | session=${sessionName}` : "";

  return [
    `## Runtime`,
    ``,
    `Runtime: agent=${agentId}${sessionPart} | channel=${ctx.channelName} | capabilities=${capabilities}`,
    ``,
    `## AskUserQuestion`,
    ``,
    `O canal suporta polls. Quando você usar a tool AskUserQuestion, a pergunta será enviada como enquete no WhatsApp.`,
    `O usuário pode votar numa opção ou responder a mensagem com texto livre (opção "Outro").`,
    `Use AskUserQuestion sempre que precisar de input do usuário com opções definidas.`,
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
 * Build output formatting section based on channel
 */
function outputFormattingText(channelName: string): string {
  if (channelName === "WhatsApp") {
    return `Ao listar itens (contacts, triggers, agents, routes, etc), use este formato:

\`\`\`
⚡ Nome da Lista (N)

1️⃣ Nome do Item
   📋 detalhe principal
   🔹 info extra | ✅ status

2️⃣ Outro Item
   📋 detalhe
   🔹 info | ❌ inativo
\`\`\`

Regras:
- Use emojis como ícones visuais
- Números com emoji (1️⃣ 2️⃣ 3️⃣) para itens
- Indentação com espaços para hierarquia
- Status com ✅ (ativo/ok) ou ❌ (inativo/erro)
- Evite tabelas markdown - WhatsApp não renderiza bem
- Mantenha conciso - telas mobile são pequenas`;
  }

  if (channelName === "Matrix") {
    return `Use markdown rico para formatação:
- Tabelas markdown funcionam bem
- Use \`código\` para IDs e comandos
- **Negrito** para destaques
- Listas com bullets para organização`;
  }

  // TUI or unknown
  return `Use formatação ASCII para tabelas e listas.
Tabelas com caracteres | - + funcionam bem no terminal.`;
}

/**
 * Build reactions section for system prompt
 */
function reactionsText(): string {
  return `Mensagens incluem \`mid:ID\` no header (dentro dos colchetes). Esse é o ID da mensagem — use para contexto ao reagir.

O header também inclui o dia da semana abreviado em inglês (mon, tue, wed, thu, fri, sat, sun) ao final do timestamp. Use para contexto temporal.

**NUNCA inclua \`[mid:...]\` ou \`mid:...\` nas suas respostas.** O mid é metadado interno, não faz parte do texto visível.

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
  ctx?: ChannelContext,
  extraSections?: PromptSection[],
  sessionName?: string,
  opts?: { agentMode?: string },
): string {
  const isSentinel = opts?.agentMode === "sentinel";
  const isLargeGroup = ctx?.isGroup && (ctx.groupMembers?.length ?? 0) >= 3;

  const builder = new PromptBuilder().section("Identidade", "Você é Ravi.");

  // System commands for all agents (sentinel needs them for cross-send execute/ask)
  builder.section("System Commands", systemCommandsText());

  // Sentinel: add explicit channel messaging instructions
  if (isSentinel) {
    builder.section(
      "Channel Messaging",
      `You are a sentinel agent — you observe messages silently and never auto-reply.
When instructed via [System] Execute or [System] Ask, you CAN send messages explicitly:

- \`ravi whatsapp dm send <contact> "message" --account $RAVI_ACCOUNT_ID\` — send a WhatsApp message
- \`ravi whatsapp dm read <contact> --account $RAVI_ACCOUNT_ID\` — read recent messages from a contact
- \`ravi whatsapp dm ack <contact> <messageId> --account $RAVI_ACCOUNT_ID\` — send read receipt (blue ticks)

The env var $RAVI_ACCOUNT_ID is set automatically with your WhatsApp account. Always use it.
Your text output is NOT sent to the channel. Use these tools to send explicitly.`,
    );
  }

  // Silent replies only for groups with 3+ members
  if (isLargeGroup) {
    builder.section("Silent Replies", buildSilentReplies().replace(/^## Silent Replies\n\n/, ""));
  }

  // Add context-dependent sections
  if (ctx) {
    // Add runtime info
    builder.section("Runtime", buildRuntimeInfo(agentId, ctx, sessionName).replace(/^## Runtime\n\n/, ""));

    if (!isSentinel) {
      // Add output formatting based on channel
      builder.section("Output Formatting", outputFormattingText(ctx.channelName));

      // Add reactions section
      builder.section("Reactions", reactionsText());
    }

    // Add group context if applicable (includes silent reply instructions)
    if (ctx.isGroup) {
      builder.section("Contexto de Grupo", buildGroupContext(ctx).replace(/^## Group Chat Context\n\n/, ""));
    }
  }

  // Plugin-injected sections
  if (extraSections) {
    for (const section of extraSections) {
      builder.section(section.title, section.content);
    }
  }

  return builder.build();
}

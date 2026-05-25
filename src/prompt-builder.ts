/**
 * Builds the system prompt appendix for agents
 */

import type { ChannelContext } from "./runtime/message-types.js";
import { renderChannelCapabilities, supportsChannelCapability } from "./channels/capabilities.js";

/** Silent reply token - when response contains this, don't send to channel */
export const SILENT_TOKEN = "@@SILENT@@";

export interface PromptSection {
  title: string;
  content: string;
}

export interface PromptContextSection extends PromptSection {
  id: string;
  priority: number;
  source: string;
  order?: number;
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
    return renderPromptSections(this.sections);
  }
}

export function renderPromptSections(sections: PromptSection[]): string {
  const orderedSections = sections.some(isPromptContextSection)
    ? sections
        .map((section, index) => ({ section, index }))
        .sort((a, b) => {
          const left = isPromptContextSection(a.section) ? a.section : null;
          const right = isPromptContextSection(b.section) ? b.section : null;
          return (
            (left?.priority ?? Number.MAX_SAFE_INTEGER) - (right?.priority ?? Number.MAX_SAFE_INTEGER) ||
            (left?.order ?? a.index) - (right?.order ?? b.index) ||
            a.index - b.index
          );
        })
        .map((entry) => entry.section)
    : sections;

  return orderedSections
    .filter((section) => section.content.trim().length > 0)
    .map((section) => `## ${section.title}\n\n${section.content}`)
    .join("\n\n");
}

function isPromptContextSection(section: PromptSection): section is PromptContextSection {
  return "priority" in section;
}

function createPromptSection(
  id: string,
  title: string,
  content: string,
  priority: number,
  order: number,
  source = "runtime",
): PromptContextSection {
  return {
    id,
    title,
    content,
    priority,
    order,
    source,
  };
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
 * Session attach/detach tools text.
 *
 * Documents the CLI surface for sessions/attach.
 * Kept as CLI documentation rather than native tools to match the existing
 * pattern used by sessions send/ask/answer/execute/inform.
 *
 * Includes the Silent vs Detach distinction so agents pick the right tool
 * for the intent (transient quiet vs persistent disengage).
 *
 * See .ravi/specs/sessions/attach/SPEC.md
 */
function sessionAttachText(): string {
  return `Sessões podem participar de múltiplos chats ao mesmo tempo. Cada chat atachado alimenta o mesmo histórico da sessão, mas cada superfície tem um estado de fala:

- \`speech=speak\` — a sessão pode emitir resposta externa nesse chat.
- \`speech=muted\` — a sessão escuta esse chat em modo listen-only; inbound entra no histórico, mas uma resposta normal sai pelo chat default com fala habilitada.

**Quando usar:**
- "Fazer esta sessão participar e responder em um chat específico" → \`attach\`
- "Escutar um chat sem falar nele" → \`mute\`
- "Permitir fala em um chat já inscrito" → \`unmute\`
- "Parar participação externa em um chat" → \`detach\`
- "Listar/inspecionar wiring e fala" → \`subscriptions\`

**Comandos:**

- \`ravi sessions attach <session> --chat <chat-id> [--reason "..."]\` — inscreve o chat no mesmo histórico, habilita fala nele e o seleciona como default output.
- \`ravi sessions mute <session> --chat <chat-id>\` — mantém a inscrição como listen-only; inbound continua entrando, mas respostas normais não saem nesse chat.
- \`ravi sessions unmute <session> --chat <chat-id>\` — habilita fala em um chat já inscrito. Use internamente antes da resposta final se o header indicar que o \`source_chat\` está muted e a resposta precisa sair ali.
- \`ravi sessions detach <session> --chat <chat-id>\` — remove a inscrição quando possível; se for o primary único, o input fica, mas a resposta externa para. **Detach é durável** até novo attach explícito.
- \`ravi sessions subscriptions <session>\` — lista chats inscritos, qual é default output e o \`speech\` de cada um.

**Resposta em múltiplas superfícies:**

- Cada inbound traz um header interno com \`source_chat\`, \`source_speech\`, default output e subscriptions.
- Se \`source_speech=speak\`, uma resposta normal pode sair no chat de origem.
- Se \`source_speech=muted\`, uma resposta normal sai pelo default output. Se for necessário responder publicamente no chat de origem, rode \`ravi sessions unmute <session> --chat <source_chat>\` antes da resposta final.
- Não explique mute, unmute, attach, subscriptions, routing ou output mechanics para usuários; trate isso como controle interno transparente.

**${SILENT_TOKEN} vs \`mute\` vs \`detach\`** (complementares, não substitutos):

- \`${SILENT_TOKEN}\` = **one-shot**, esse turn específico não fala. Próxima inbound, agent volta a responder normalmente. Use quando "li, mas não tenho nada a dizer agora".
- \`mute\` = **estado durável listen-only**, a sessão continua escutando o chat, mas não fala nele até \`unmute\`.
- \`detach\` = **estado durável de remoção**, a sessão deixa de participar daquele chat quando possível.

**Anti-patterns:**

- ❌ Adicionar route pra "mover" chat já atachado em outra sessão — subscription override puxa de volta. Detach (ou \`sessions delete\` da sessão antiga) primeiro.
- ❌ Tentar redirecionar output com \`focus\` — focus não existe; use \`attach\` para escolher o chat que recebe as respostas da sessão.
- ❌ Externalizar para o usuário que você está mutando, desmutando ou roteando uma resposta.
- ❌ Esperar attach trocar o agent. Attach decide sessão; agent vem da route ou default da instance.`;
}

function sessionActionsText(sessionName?: string): string {
  const sessionRef = sessionName ?? "<session>";
  return `Use \`ravi sessions actions --json\` para inspecionar as ações disponíveis nesta sessão, as superfícies atuais e os IDs recentes das mensagens que você mesmo enviou.

Essa é a fonte canônica para descobrir operações conversacionais do chat, como apagar ou editar suas próprias mensagens, reagir, responder, enviar stickers e novas capacidades expostas pelo runtime. Não assuma que uma ação existe: consulte esta superfície quando precisar trabalhar sobre uma mensagem ou canal.

O CLI infere a sessão pelo contexto de execução do agent. Não passe o nome da sessão quando estiver rodando dentro do Ravi; use \`ravi sessions actions ${sessionRef} --json\` apenas para depuração fora do runtime.

Para apagar uma mensagem própria enviada por engano, primeiro descubra o ID em \`recentOwnMessages\` e depois rode \`ravi sessions delete-message <message-id>\`.

Para editar uma mensagem própria enviada por engano, primeiro descubra o ID em \`recentOwnMessages\` e depois rode \`ravi sessions edit-message <message-id> "novo texto"\`.

Só apague ou edite mensagens próprias quando estiver corrigindo ou removendo uma saída acidental. Não exponha IDs internos ao usuário a menos que isso seja útil para depuração.`;
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
  const capabilities = renderChannelCapabilities(ctx);
  const sessionPart = sessionName ? ` | session=${sessionName}` : "";

  const lines = [
    `## Runtime`,
    ``,
    `Runtime: agent=${agentId}${sessionPart} | channel=${ctx.channelName} | capabilities=${capabilities}`,
  ];

  if (supportsChannelCapability(ctx, "polls")) {
    lines.push(
      ``,
      `## AskUserQuestion`,
      ``,
      `O canal suporta polls. Quando você usar a tool AskUserQuestion, a pergunta será enviada como enquete no WhatsApp.`,
      `O usuário pode votar numa opção ou responder a mensagem com texto livre (opção "Outro").`,
      `Use AskUserQuestion sempre que precisar de input do usuário com opções definidas.`,
    );
  }

  return lines.join("\n");
}

function sessionBoundaryText(sessionName?: string): string {
  const sessionRef = sessionName ? `current session (${sessionName})` : "current session";
  return [
    `Treat the ${sessionRef} as the only conversational context for this reply.`,
    `DMs, groups, channels, and threads are separate contexts even when the same people participate.`,
    `If local context looks incomplete, use same-session history tools such as \`ravi sessions read --json\` or \`ravi sessions trace ${sessionName ?? "<session>"}\`.`,
    `Never recover missing context from another DM/group/session or from unrelated filesystem notes.`,
    `If same-session durable history is unavailable, ask the user for the missing context instead of guessing.`,
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

export function buildSystemPromptSections(
  agentId: string,
  ctx?: ChannelContext,
  extraSections?: PromptSection[],
  sessionName?: string,
  opts?: { agentMode?: string },
): PromptContextSection[] {
  const isSentinel = opts?.agentMode === "sentinel";
  const isLargeGroup = ctx?.isGroup && (ctx.groupMembers?.length ?? 0) >= 3;
  const sections: PromptContextSection[] = [];
  let order = 0;
  const add = (id: string, title: string, content: string, priority: number, source = "runtime") => {
    sections.push(createPromptSection(id, title, content, priority, order++, source));
  };

  add("identity", "Identidade", "Você é Ravi.", 10);

  // System commands for all agents (sentinel needs them for cross-send execute/ask)
  add("system.commands", "System Commands", systemCommandsText(), 20);

  // Sessions attach/detach CLI surface. Added for all agents so the
  // multi-input primitive is discoverable. See sessions/attach spec.
  add("session.attach", "Session Attach", sessionAttachText(), 25);
  add("session.actions", "Session Actions", sessionActionsText(sessionName), 30);

  // Sentinel: add explicit channel messaging instructions
  if (isSentinel) {
    add(
      "sentinel.channel_messaging",
      "Channel Messaging",
      `You are a sentinel agent — you observe messages silently and never auto-reply.
When instructed via [System] Execute or [System] Ask, you CAN send messages explicitly:

- \`ravi whatsapp dm send <contact> "message" --account $RAVI_ACCOUNT_ID\` — send a WhatsApp message
- \`ravi whatsapp dm read <contact> --account $RAVI_ACCOUNT_ID\` — read recent messages from a contact
- \`ravi whatsapp dm ack <contact> <messageId> --account $RAVI_ACCOUNT_ID\` — send read receipt (blue ticks)

The env var $RAVI_ACCOUNT_ID is set automatically with your WhatsApp account. Always use it.
Your text output is NOT sent to the channel. Use these tools to send explicitly.`,
      35,
    );
  }

  // Silent replies only for groups with 3+ members
  if (isLargeGroup) {
    add("group.silent_replies", "Silent Replies", buildSilentReplies().replace(/^## Silent Replies\n\n/, ""), 40);
  }

  // Add context-dependent sections
  if (ctx) {
    // Add runtime info
    add("session.runtime", "Runtime", buildRuntimeInfo(agentId, ctx, sessionName).replace(/^## Runtime\n\n/, ""), 50);
    add("session.boundary", "Session Boundary", sessionBoundaryText(sessionName), 60);

    if (!isSentinel) {
      // Add output formatting based on channel
      add("channel.output_formatting", "Output Formatting", outputFormattingText(ctx.channelName), 70);

      if (supportsChannelCapability(ctx, "reactions")) {
        add("channel.reactions", "Reactions", reactionsText(), 80);
      }
    }

    // Add group context if applicable (includes silent reply instructions)
    if (ctx.isGroup) {
      add("group.context", "Contexto de Grupo", buildGroupContext(ctx).replace(/^## Group Chat Context\n\n/, ""), 90);
    }
  }

  // Plugin-injected sections
  if (extraSections) {
    for (const section of extraSections) {
      add(
        `extra.${section.title.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`,
        section.title,
        section.content,
        100,
        "extra",
      );
    }
  }

  return sections;
}

/**
 * Build system prompt with channel context.
 *
 * The final prompt is always human-readable Markdown. Section metadata exists
 * only inside the builder pipeline for ordering, dedupe, tests, and trace.
 */
export function buildSystemPrompt(
  agentId: string,
  ctx?: ChannelContext,
  extraSections?: PromptSection[],
  sessionName?: string,
  opts?: { agentMode?: string },
): string {
  return renderPromptSections(buildSystemPromptSections(agentId, ctx, extraSections, sessionName, opts));
}

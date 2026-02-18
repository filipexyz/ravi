---
name: prompt-builder
description: |
  Documenta o sistema de construcao de prompts do Ravi. Use quando precisar:
  - Entender como system prompts sao montados
  - Adicionar novas secoes ao prompt
  - Modificar formatacao por canal
  - Entender injecao de contexto (grupo, reactions, runtime)
  - Criar novas regras de output por plataforma
---

# Prompt Builder - Sistema de Injecao de Contexto

O prompt builder constroi o system prompt appendix que e injetado em cada chamada do Claude SDK.
Ele adapta o comportamento do agent baseado no canal, grupo, e contexto da mensagem.

**Arquivo:** `src/prompt-builder.ts`

## Como Funciona

```typescript
// bot.ts - na hora de processar prompt
const systemPromptAppend = buildSystemPrompt(agent.id, prompt.context);

query({
  prompt: prompt.prompt,
  options: {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: systemPromptAppend,  // <-- injetado aqui
    },
  },
});
```

O SDK usa o preset `claude_code` como base e appenda nossas secoes.

## Estrutura do Builder

```typescript
class PromptBuilder {
  section(title: string, content: string): this;
  build(): string;  // Retorna "## Title\n\nContent" para cada secao
}
```

## Secoes Injetadas

A funcao `buildSystemPrompt(agentId, ctx)` monta as secoes:

### 1. Identidade (sempre)
```
## Identidade
Voce e Ravi.
```

### 2. System Commands (sempre)
Protocolo de comandos internos:
- `[System] Inform: <info>` - Avalie a info e decida: silêncio (@@SILENT@@), resposta breve, ou ação com tools
- `[System] Execute: <task>` - Execute usando tools
- `[System] Ask: [from: <session>] <question>` - Pergunta cross-session
- `[System] Answer: [from: <session>] <response>` - Resposta cross-session
- *(relay não tem prefixo — chega como mensagem normal)*

### 3. Runtime (quando tem contexto de canal)
```
Runtime: agent=main | channel=WhatsApp | capabilities=polls,reactions
```

### 4. Output Formatting (quando tem contexto de canal)
Formatacao adaptada por plataforma:

**WhatsApp:**
- Listas com emojis numerados (1, 2, 3)
- Icones visuais para hierarquia
- Status com check/x
- Sem tabelas markdown
- Conciso (telas mobile)

**Matrix:**
- Markdown rico (tabelas, negrito, codigo)

**TUI:**
- ASCII tables (| - +)

### 5. Reactions (quando tem contexto de canal)
Instrucoes de quando usar emoji reactions vs texto:
- Prefira emoji sobre "ok", "entendi", "beleza"
- Use `react_send` com o `[mid:ID]` da mensagem
- Nao reaja E responda ao mesmo tempo

### 6. Contexto de Grupo (quando isGroup=true)
```
Voce esta respondendo no grupo "Familia".
Membros: Joao, Maria, Luis.
Seja seletivo: responda so quando mencionado ou claramente util.
Se nao precisa responder: @@SILENT@@
```

## Fluxo de Contexto

```
WhatsApp msg recebida
    -> Channel normaliza -> InboundMessage
    -> Gateway extrai MessageContext:
       { channelId, channelName, senderId, isGroup, groupName, groupMembers, ... }
    -> Emite para bot com context
    -> bot.ts chama buildSystemPrompt(agentId, context)
    -> Prompt appendix montado com secoes relevantes
    -> Passado para Claude SDK
```

## MessageContext (origem)

```typescript
interface MessageContext {
  channelId: string;       // "whatsapp"
  channelName: string;     // "WhatsApp"
  accountId: string;       // "default"
  chatId: string;          // "5511999999999"
  messageId: string;       // ID da msg
  senderId: string;        // Quem mandou
  senderName?: string;     // Nome do remetente
  senderPhone?: string;    // Telefone
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  timestamp: number;
}
```

## ChannelContext (persistido)

Metadados estaveis que sao salvos na sessao para reuso:

```typescript
interface ChannelContext {
  channelId: string;
  channelName: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
}
```

Salvo em `sessions.last_context` como JSON. Usado pelo cross-send para reconstruir contexto.

## Silent Token

```typescript
export const SILENT_TOKEN = "@@SILENT@@";
```

Quando o agent responde com este token:
- Gateway NAO envia para o canal
- Bot emite evento `{ type: "silent" }` para parar typing
- Usado em grupos quando nao precisa responder

## Como Adicionar uma Nova Secao

1. Crie a funcao no `prompt-builder.ts`:
```typescript
function minhaSecao(ctx: ChannelContext): string {
  return `Instrucoes especificas aqui...`;
}
```

2. Adicione ao builder em `buildSystemPrompt()`:
```typescript
builder.section("Minha Secao", minhaSecao(ctx));
```

3. Rebuild e reinicie o daemon.

## Como Adicionar Formatacao para Novo Canal

1. Adicione um case em `outputFormattingText()`:
```typescript
if (channelName === "MeuCanal") {
  return `Regras de formatacao para MeuCanal...`;
}
```

2. O channelName vem do `channelType` do OmniConsumer (ex: `"whatsapp-baileys"`, `"discord"`, `"telegram"`).

## Outbound System Context

O sistema de outbound injeta contexto adicional via `prompt._outboundSystemContext`:
```typescript
if (prompt._outboundSystemContext) {
  systemPromptAppend += "\n\n" + prompt._outboundSystemContext;
}
```

Isso inclui:
- Instrucoes da queue
- Tools disponiveis (outbound_send, outbound_qualify, etc)
- Workflow de qualificacao
- Metadata da entry (ID, round, qualification)

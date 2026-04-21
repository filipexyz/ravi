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

O prompt builder constroi secoes de prompt em Markdown. O contrato interno e tipado para ordenar,
deduplicar e auditar secoes, mas o texto final enviado ao runtime e sempre Markdown humano, nunca JSON.

Camadas principais:

- `src/prompt-builder.ts` - secoes base de identidade, comandos internos, sessao, canal e grupo.
- `src/runtime/runtime-system-prompt.ts` - composicao runtime final com workspace, agent e secoes extras.
- `src/runtime/runtime-request-builder.ts` - chama o builder final antes de iniciar o runtime.

## Como Funciona

```typescript
// runtime-request-builder.ts
const { text: systemPromptAppend } = await buildRuntimeSystemPrompt({
  agent,
  ctx: prompt.context,
  sessionName,
  cwd: sessionCwd,
});
```

O runtime adapter recebe `systemPromptAppend` como texto Markdown renderizado.

## Estrutura do Builder

```typescript
type PromptContextSection = {
  id: string;
  title: string;
  content: string;
  priority: number;
  source: string;
}

renderPromptSections(sections); // Retorna "## Title\n\nContent" para cada secao
```

## Secoes Base

A funcao `buildSystemPromptSections(agentId, ctx)` monta as secoes base:

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
- O `[mid:ID]` no header identifica a mensagem
- Nao reaja E responda ao mesmo tempo

### 6. Contexto de Grupo (quando isGroup=true)
```
Voce esta respondendo no grupo "Familia".
Membros: Joao, Maria, Luis.
Seja seletivo: responda so quando mencionado ou claramente util.
Se nao precisa responder: @@SILENT@@
```

## Secoes Runtime

`buildRuntimeSystemPrompt()` adiciona secoes acima da base.

### Workspace Instructions

Carrega as instrucoes canonicas do `cwd` do agent:

1. prefere `AGENTS.md`
2. usa fallback legado quando necessario
3. cria/usa bridge de compatibilidade quando aplicavel

Render:

```markdown
## Workspace Instructions

Workspace instructions loaded from /path/AGENTS.md. Treat them as authoritative for this workspace.
Resolve relative file references from /path/.

...conteudo do AGENTS.md...
```

### Agent Instructions

Injeta `agent.systemPromptAppend` como texto Markdown:

```markdown
## Agent Instructions

...conteudo configurado no agent...
```

## Fluxo de Contexto

```
WhatsApp msg recebida
    -> Channel normaliza -> InboundMessage
    -> Gateway extrai MessageContext:
       { channelId, channelName, senderId, isGroup, groupName, groupMembers, ... }
    -> Emite para bot com context
    -> runtime-request-builder chama buildRuntimeSystemPrompt(...)
    -> Prompt appendix montado como Markdown
    -> Runtime adapter recebe systemPromptAppend
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

1. Crie uma funcao/provider que retorne `PromptContextSection`:

```typescript
function minhaSecao(ctx: ChannelContext): PromptContextSection {
  return {
    id: "minha.secao",
    title: "Minha Secao",
    content: "Instrucoes especificas aqui...",
    priority: 65,
    source: "runtime",
  };
}
```

2. Adicione ao array de secoes antes de chamar `renderPromptSections()`.

3. Garanta que o render final continue sendo Markdown:

```markdown
## Minha Secao

Instrucoes especificas aqui...
```

## Regra Importante

Nao injete JSON no system prompt. O JSON/metadata vive so no contrato interno, no trace ou no banco.
O texto final precisa ser legivel como documento Markdown.

## Como Adicionar Formatacao para Novo Canal

1. Adicione um case em `outputFormattingText()`:
```typescript
if (channelName === "MeuCanal") {
  return `Regras de formatacao para MeuCanal...`;
}
```

2. O `channelName` vem do contexto normalizado da mensagem.

## Validacao Recomendada

```bash
bun test src/prompt-builder.test.ts src/runtime/runtime-system-prompt.test.ts
bun run typecheck
```

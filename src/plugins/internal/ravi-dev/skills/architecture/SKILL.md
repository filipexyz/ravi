---
name: ravi-architecture
description: |
  Documentacao completa da arquitetura do Ravi. Use quando precisar:
  - Entender como o sistema funciona end-to-end
  - Modificar componentes existentes
  - Adicionar novos subsistemas
  - Debugar fluxos de mensagem
  - Onboarding no codebase
---

# Ravi - Arquitetura do Sistema

Ravi é um runtime multi-agent com canais via omni, coordenação interna por NATS JetStream,
estado em SQLite e execução por providers plugáveis atrás de um contrato único.

**Repositório:** `<ravi.bot repo>`
**Runtime:** Bun
**DB:** SQLite
**PubSub:** NATS JetStream

## Fluxo Principal de Mensagens

```text
WhatsApp/Discord/Telegram/Matrix
  -> omni API
  -> NATS JetStream MESSAGE
  -> OmniConsumer
  -> ravi.<session>.prompt
  -> RuntimePromptSubscription
  -> RuntimeSessionDispatcher
  -> RuntimeSessionLauncher
  -> RuntimeProvider.startSession(RuntimeStartRequest)
  -> RuntimeEvent stream
  -> RuntimeEventLoop
  -> ravi.session.<session>.runtime/tool/stream/response
  -> Gateway
  -> OmniSender
  -> canal
```

## Fronteiras Core

### `daemon.ts`

Composition root do processo:

- carrega env de `~/.ravi/.env`
- inicia NATS/JetStream
- inicia omni
- inicia RaviBot
- inicia OmniConsumer e Gateway
- inicia heartbeat, cron e triggers
- controla shutdown global

### `bot.ts`

Composition root do runtime de conversas.

Responsabilidades permitidas:

- construir `RuntimeSessionDispatcher`
- construir `RuntimePromptSubscription`
- construir `RuntimeHostSubscriptions`
- iniciar/parar subscriptions
- expor wrappers estreitos para testes/CLI

Responsabilidades proibidas:

- lógica específica de provider
- montagem de prompt/env/provider request
- autorização de tool/bash/session
- event loop de provider
- regra de fila/interrupção
- regra de task/profile/model

### `runtime/session-dispatcher.ts`

Decide o que fazer com um prompt:

- debounce
- sessão viva vs cold start
- troca de provider
- troca de modelo/effort/thinking
- queue, wake, interrupt
- delivery barrier
- after_task deferral
- limite de concorrência

### `runtime/session-launcher.ts`

Orquestra o start de uma sessão runtime.

Não deve virar saco de responsabilidades. Ele coordena:

- resolução de sessão/agent/provider via `session-resolver`
- resolução task/profile/model via `task-runtime-context`
- montagem do `RuntimeStartRequest` via `runtime-request-builder`
- persistência inicial de provider state
- aceite da task vinculada
- start do `RuntimeEventLoop`

### `runtime/runtime-request-builder.ts`

Compoe o `RuntimeStartRequest` final a partir dos modulos menores:

- `runtime-request-context.ts` — runtime context, tool context e env Ravi
- `runtime-provider-bootstrap.ts` — `prepareSession`, host services e plugins
- `runtime-session-continuity.ts` — resume/fork por provider state
- `runtime-host-attachments.ts` — hooks, spec server e remote spawn
- `runtime-request-builder.ts` — composicao final do start request

Regra: novo provider entra por adapter + capabilities. Nao adicionar branch por provider em
`bot.ts`, `session-launcher.ts` ou `runtime-request-builder.ts`.

### `runtime/host-services.ts`

Bridge de serviços do host:

- dynamic tools
- autorização de tool
- autorização de comando
- autorização de capability
- user input/poll
- session scope
- auditoria de denies

### `runtime/host-hooks.ts`

Bridge de hooks nativos quando o provider suporta:

- pre-tool permission
- bash permission
- sanitize bash
- pre-compact
- AskUserQuestion
- spec/exit plan hooks

### `runtime/host-event-loop.ts`

Traduz eventos do provider para eventos canônicos Ravi:

- `runtime`
- `tool`
- `stream`
- `response`

Também persiste provider session state em `turn.complete`.

## Runtime Provider Contract

O provider é adapter. O Ravi runtime é a fonte de verdade.

Contrato canônico:

- provider recebe `RuntimeStartRequest`
- provider emite `RuntimeEvent`
- provider declara `RuntimeCapabilities`
- provider pode expor `interrupt`, `setModel` e `control`
- provider não muta task/session/canal diretamente

Documento canônico: `docs/runtime-provider-contract.md`

Checklist para novo provider:

1. Implementar `RuntimeProvider` e declarar `RuntimeCapabilities`.
2. Usar `prepareSession` apenas para env/bootstrap/dynamic tools/approvals.
3. Normalizar output nativo para `RuntimeEvent`.
4. Cobrir capability matrix e prepare-session shape nos testes de contrato.
5. Criar testes especificos do provider para normalizacao de eventos.

## Capability Gates

Use `RuntimeCapabilities`, nunca branch solto por provider fora do registry/adapters.

Capabilities importantes:

- `supportsSessionResume`
- `supportsSessionFork`
- `supportsPartialText`
- `supportsToolHooks`
- `supportsHostSessionHooks`
- `supportsPlugins`
- `supportsMcpServers`
- `supportsRemoteSpawn`
- `toolAccessRequirement`
- `legacyEventTopicSuffix`

## Model Switching

A troca de modelo é estratégia runtime:

- `direct-set`: handle suporta `setModel`
- `restart-next-turn`: precisa reiniciar antes do próximo turno

Código: `runtime/model-switch.ts`

Não faça branch por provider para isso.

## Router / Sessions

Resolução de rota:

1. `thread:<id>`
2. grupo/contato
3. instance default agent
4. global default agent

Session key segue o formato:

```text
agent:<agentId>:main
agent:<agentId>:dm:<phone>
agent:<agentId>:whatsapp:group:<groupId>
agent:<agentId>:whatsapp:main:group:<groupId>:thread:<threadId>
```

O runtime autoritativo é a sessão no DB + provider state persistido.

## Tasks / Profiles / Workflow / Project

Fronteira obrigatória:

- `task` executa
- `profile` define protocolo local da task
- `workflow` coordena nodes/edges/readiness/run state
- `project` organiza alignment/contexto

Invariantes:

- `parentTaskId` não é scheduling
- `launch plan` fica na task
- `project_id` não deve ser gravado direto em tasks
- task aparece em project por inferência via workflow
- profile não coordena workflow

## Plugins / Skills

Plugins internos ficam em `src/plugins/internal`.

Build:

```bash
bun run gen:plugins
```

Isso atualiza `src/plugins/internal-registry.ts`.

Skills nativas de runtime podem ser sincronizadas para ambientes de provider quando suportado.

## Validação Recomendada Antes De Fechar Mudança Core

```bash
bun test src/runtime/model-switch.test.ts src/runtime/provider-contract.test.ts src/runtime/index.test.ts
bun test src/bot.runtime-guards.test.ts src/delivery-barriers.test.ts
bun run typecheck
bun run build
```

Se mexer em provider adapter, rode também o teste específico do provider alterado.

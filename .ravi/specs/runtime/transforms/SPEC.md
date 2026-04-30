---
id: runtime/transforms
title: "Runtime Transform Pipeline"
kind: capability
domain: runtime
capability: transforms
tags:
  - runtime
  - transforms
  - hooks
  - plugins
  - observability
applies_to:
  - src/runtime/runtime-event-loop.ts
  - src/runtime/runtime-request-context.ts
  - src/plugins/index.ts
  - src/skills/manager.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Transform Pipeline

## Intent

`transforms` define como o runtime do Ravi compõe múltiplas operações sobre cada tool call — antes da execução (PreToolUse) e depois (PostToolUse) — de forma ordenada, declarativa e composável. A capability é o substrato que viabiliza skill-gate, audit, plugin-driven enrichment, e a integração com proxies externos como o RTK sem que nenhum deles colida com os outros.

A capability existe porque hoje cada feature que precisa "interceptar uma chamada de ferramenta" implementa sua própria injeção ad-hoc. Sem um pipeline canônico, qualquer adição (skill-gate, output compression, audit) vira um patch específico no event loop, multiplicando complexidade e acoplamento.

## Modelo

Cada sessão do runtime mantém **dois pipelines** ordenados associados à execução de qualquer tool:

- **PreToolUse pipeline** — executa antes da ferramenta receber controle. Pode mutar o input, abortar com erro estruturado, injetar contexto adicional, ou apenas observar.
- **PostToolUse pipeline** — executa depois da ferramenta completar. Pode mutar o output entregue ao agente, anexar metadados, gravar evento de telemetria, ou apenas observar.

Cada item do pipeline é um **transform** com:

- **id** — identificador estável (`skill-gate`, `audit-log`, `plugin:foo:filter`).
- **stage** — `pre` ou `post`.
- **priority** — número estável que ordena execução (menor = primeiro). Empates resolvidos por ordem lexicográfica do id.
- **scope** — `global`, `agent`, ou `tool:<name>`. Limita onde aplica.
- **handler** — função pura `(input, ctx) → output | error`. Idempotente quando possível.
- **origin** — `builtin`, `plugin:<name>`, ou `external:<name>`. Audita procedência.

## Origens

Transforms entram no pipeline a partir de três fontes:

### Builtin

Definidos no próprio runtime (`src/runtime/transforms/`). Cobrem capacidades centrais: `skill-gate`, `audit-log`, `token-track`, `permission-check`. Não dependem de plugin instalado.

### Plugin

Plugins associados à sessão (ver `runtime/skill-loading` + `plugins/runtime-sync`) podem declarar transforms no manifest. Schema mínimo:

```toml
[[transforms]]
id        = "tiny:order-validation"
stage     = "pre"
scope     = "tool:tiny:order-create"
priority  = 100
handler   = "./bin/tiny-validate"
```

O handler pode ser inline (TOML declarativo, modelo dos filtros do RTK em `src/filters/*.toml`) ou externo (binário spawned pelo runtime, mesmo contrato `RAVI_CONTEXT_KEY`).

### External

Transforms vivendo **fora** do runtime do Ravi — tipicamente PreToolUse hooks instalados no provider (Claude Code, Codex, etc) por ferramentas como o RTK. O runtime do Ravi **não orquestra** esses transforms; apenas detecta, reporta via `runtime/session-visibility`, e respeita o domínio. Detalhes em `runtime/transforms/external-integrations`.

## Regra de Não-Duplicação

Transforms de diferentes origens MUST NOT cobrir o mesmo domínio funcional para o mesmo `scope`. Em particular:

- Plugins do Ravi MUST NOT declarar filtros de output (PostToolUse) para comandos shell genéricos cobertos por proxies externos conhecidos. A lista canônica de cobertura externa vive em `runtime/transforms/external-integrations` (RTK cobre git, gh, cargo, pnpm, npm, npx, pytest, etc).
- Plugins do Ravi declaram filtros apenas para CLIs do próprio plugin (ex: plugin de música declara filtro para `mpc`/`spotify-cli`, não para `git status`).
- Builtin transforms do Ravi cobrem comportamento estrutural (skill-gate, audit) que **não é** filtro de output. Por construção não colidem com o domínio do RTK.

A regra é normativa: o runtime MUST detectar duplicação por scope e MUST reportar como erro de configuração na carga do pipeline, não silenciar.

## Ordem de Execução

Para um único tool call, a sequência canônica é:

```
[Ravi runtime PreToolUse pipeline]
        ↓
[Provider PreToolUse hook (RTK, etc) — se instalado]
        ↓
[Tool execution real]
        ↓
[Provider PostToolUse hook (RTK, etc) — se instalado]
        ↓
[Ravi runtime PostToolUse pipeline]
```

O Ravi opera **em volta** do provider hook layer. Não substitui, não duplica. O ganho do RTK é aditivo ao do Ravi quando ambos estão presentes.

Dentro de cada pipeline do Ravi, transforms executam por `priority` ascendente. Um transform que falhar com erro estruturado MUST abortar o pipeline e propagar o erro para o agente — exceção: transforms `observe-only` (audit, telemetria, priority alta convencional ≥900) MUST NOT abortar mesmo em erro próprio.

## Regras

- Cada transform MUST ser registrado antes da primeira tool call da sessão. Registro tardio MUST ser rejeitado.
- Pipelines MUST ser determinísticos: mesma sessão + mesmo input → mesma sequência de transforms aplicados.
- Mutações de input/output MUST ser explícitas. Um transform que retorna o input inalterado MUST sinalizar `unchanged` para o runtime poder otimizar.
- Cada execução de transform MUST emitir evento estruturado no stream de eventos do runtime (transform-id, stage, scope, duration, mutation flag, error if any).
- Erros de transform MUST incluir: id do transform, origem, mensagem, e se a falha é fatal (aborta o pipeline) ou recuperável (passa pro próximo).
- O runtime MUST expor `ravi transforms list` (ou equivalente) para o operador auditar quais transforms estão ativos na sessão atual.

## Interação com Outras Capabilities

- `runtime/context-keys/skill-gate` — caso particular de transform PreToolUse com policy de gate (hard/soft/passive). Ver spec específica.
- `runtime/skill-loading` — `loadedSkills` é input para skill-gate; transforms podem ler mas MUST NOT mutar.
- `runtime/session-visibility` — expõe lista de transforms ativos e contagem de execuções por sessão.
- `plugins/runtime-sync` — instalação de plugin pode trazer novos transforms; sync MUST resolver-los antes da primeira tool call.
- `runtime/transforms/external-integrations` — define como integrações externas (RTK, etc) são detectadas e reportadas sem entrar no pipeline orquestrado.

## Failure Modes

- **Transform conflitante** — dois transforms do mesmo scope com priority igual e ids diferentes. Runtime MUST falhar fast no registro com erro de configuração.
- **Transform que duplica external integration** — plugin tenta declarar filtro para comando coberto pelo RTK (quando detectado). Runtime MUST rejeitar com mensagem citando a regra de não-duplicação e a integração externa que cobre o caso.
- **Transform externo (handler binário) trava** — runtime MUST aplicar timeout (default 5s para PreToolUse, 10s para PostToolUse) e tratar como erro recuperável (log + skip do transform específico, pipeline continua).
- **Mutação não declarada** — transform muta input/output sem sinalizar mutation flag. Runtime MUST detectar via hash e reportar como bug do transform.

## Acceptance Criteria

- Skill-gate (existente) reimplementado como transform PreToolUse builtin sem mudança de comportamento observável.
- Plugin com `[[transforms]]` no manifest tem seus transforms registrados na sessão automaticamente após sync.
- Sessão com RTK instalado reporta `external:rtk` em `runtime/session-visibility`, mas RTK NÃO aparece como item do pipeline orquestrado pelo Ravi.
- Tentativa de plugin declarar filtro de output para `git status` (coberto pelo RTK) num ambiente com RTK detectado MUST falhar no carregamento com erro citando a regra.
- `ravi transforms list` retorna a lista determinística para a sessão atual com origin, stage, scope, priority.
- Eventos estruturados de transform são queryáveis via `ravi events` filtrados por id/origin/stage.

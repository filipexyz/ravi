---
id: runtime/transforms/external-integrations
title: "External Transformer Integrations"
kind: feature
domain: runtime
capability: transforms
feature: external-integrations
tags:
  - runtime
  - transforms
  - rtk
  - external
  - interop
applies_to:
  - src/runtime
  - src/cli/commands/sessions.ts
  - src/cli/commands/context.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# External Transformer Integrations

## Intent

`external-integrations` define como o Ravi detecta, reporta e respeita transforms instalados **fora** do seu runtime — tipicamente PreToolUse hooks que vivem no provider (Claude Code, Codex, Cursor) e foram instalados por ferramentas como o RTK. A feature garante que o Ravi compõe com essas ferramentas sem duplicar trabalho, sem assumir controle, e sem falhar quando elas estão ausentes.

A feature existe porque o ecossistema de proxies/filtros pra LLM CLIs está crescendo (RTK, openclaw e outros) e o Ravi nunca vai cobrir tudo internamente. O caminho correto é **complementar, não competir**: o Ravi cuida do que é específico ao seu modelo (skill-gate, plugin lifecycle, audit), ferramentas externas cuidam do que generaliza (compress de output de comandos shell).

## Modelo

Na criação de uma sessão, o runtime executa um **discovery pass** que identifica integrações externas conhecidas pela presença no PATH e versão mínima suportada. O resultado é cacheado por sessão e exposto via `runtime/session-visibility`.

Ferramentas reconhecidas hoje:

| Ferramenta | Detecção | Domínio | Versão Mínima |
|------------|----------|---------|---------------|
| RTK | `which rtk` + `rtk --version` | output filter de comandos shell genéricos (git, gh, cargo, pnpm, npm, npx, pytest, ruff, etc) | 0.23.0 |

A lista é canônica e MUST ser mantida em sync com a regra de não-duplicação de `runtime/transforms`. Adicionar uma ferramenta nova requer atualizar esta lista E o conjunto de comandos que plugins do Ravi MUST NOT cobrir.

## Regras

- O discovery pass MUST executar antes da primeira tool call da sessão. Detecção tardia (após a sessão começar) MUST NOT mudar comportamento da sessão atual.
- O Ravi MUST NOT invocar diretamente ferramentas externas. Elas operam autonomamente no provider hook layer; o Ravi apenas reconhece a presença.
- A ausência de uma ferramenta externa MUST ser tratada como estado normal. O Ravi MUST funcionar com pipeline reduzido sem warnings ruidosos.
- Versão de uma ferramenta externa abaixo da mínima MUST gerar warning estruturado uma vez por sessão, com a versão atual e a mínima requerida. Não bloqueia.
- Detecção MUST ser determinística e cacheável: mesmo PATH + mesmas versões → mesmo resultado.
- Plugins do Ravi MUST NOT redeclarar filtros para comandos cobertos por uma ferramenta externa detectada na sessão. O check de não-duplicação (definido em `runtime/transforms`) usa esta tabela como fonte da verdade.

## Reporting

`runtime/session-visibility` MUST incluir um campo `externalTransformers` com shape:

```json
{
  "externalTransformers": {
    "rtk": {
      "version": "0.28.2",
      "path": "/Users/luis/.local/bin/rtk",
      "covers": ["git", "gh", "cargo", "pnpm", "npm", "npx", "pytest", "cargo-clippy"],
      "detectedAt": "2026-04-30T20:15:00Z"
    }
  }
}
```

`covers` lista os comandos-base cobertos (não regex). É consumido por:

- O check de não-duplicação ao carregar plugins.
- O operador via `ravi sessions visibility <session>`.
- Telemetria pra entender quanto da economia vem de ferramenta externa vs builtin do Ravi.

## Comportamento Sem Ferramenta Externa

Quando RTK (ou equivalente) não está presente:

- O Ravi NÃO ativa filtros próprios pra cobrir o gap. A regra de domínio continua: filtros genéricos não pertencem ao Ravi.
- O operador PODE instalar plugin opcional do Ravi (ex: `ravi-output-compress`) que cobre parcialmente o domínio. Esse plugin é tratado como qualquer outro plugin (declara transforms via manifest, sujeito à regra de não-duplicação caso outra integração externa apareça depois).
- A entrada `externalTransformers` em `session-visibility` MUST refletir ausência (campo presente, valor `{}`), não omitido.

## Failure Modes

- **PATH dinâmico** — discovery é one-shot na criação. Mudanças no PATH durante a sessão NÃO ativam re-discovery automático. Operador pode forçar via `ravi sessions refresh-discovery <session>`.
- **Versão muito alta** — não bloqueia. Se a versão tem comportamento incompatível detectado por testes do Ravi, MUST emitir warning estruturado.
- **Múltiplas ferramentas com domínios sobrepostos** — futuro: dois proxies cobrindo `git` simultaneamente. Resolução fora de escopo nesta versão; MUST emitir warning estruturado e o operador resolve manualmente.
- **Ferramenta detectada mas hook não instalado no provider** — falsa promessa: binário existe no PATH, mas o provider não está roteando tool calls através dele. Detectável por evento estruturado de tool call que não passou pelo hook esperado. MUST ser reportado em `ravi events errors` com hint para o operador rodar `rtk init` (ou equivalente).

## Acceptance Criteria

- Sessão criada em ambiente com RTK 0.23+ instalado reporta `externalTransformers.rtk` com versão correta em `session-visibility`.
- Sessão criada sem RTK reporta `externalTransformers: {}` (presente, vazio).
- Plugin declarando filtro pra `git status` num ambiente com RTK detectado MUST falhar no load com mensagem citando `runtime/transforms` regra de não-duplicação e nomeando a integração externa que cobre o caso.
- O mesmo plugin no mesmo ambiente sem RTK detectado MUST carregar normalmente (sem RTK não há conflito de domínio).
- Adicionar uma ferramenta nova à tabela canônica é uma mudança de spec (esta) E de código (`runtime/transforms` regras). Mudanças isoladas em apenas um dos lados MUST falhar no `ravi specs sync` ou em testes de consistência.

---
id: skills/scoping/per-agent-visibility
title: "Per-Agent Skill Visibility"
kind: feature
domain: skills
capabilities:
  - scoping
tags:
  - skills
  - context-window
  - runtime
applies_to:
  - runtime skill filtering (provider-agnostic core + per-provider enforcement adapter)
  - ravi skills CLI
owners:
  - main
status: active
normative: true
review: "v3 KISS 2026-07-02 — núcleo provider-agnostic; visibilidade de skill de sistema DERIVADA da permissão (sem mapa manual); grant só para skills personalizadas. Substitui a v2 (que travava em claude-only e usava mapa manual para tudo)."
---

# Per-Agent Skill Visibility

## Intent

Cada agente vê no contexto **só as skills que fazem sentido pra ele** — resolvido **por agente, a cada turno**. Resolve 3 dores: poluição de índice (todas as skills em todos os agentes, todo turno), duplicação de skill personalizada, e falta de ownership.

**Dois mecanismos, um resultado:**
1. **Skills de sistema (`ravi-system:*`)** → visibilidade **DERIVADA da permissão** do agente. Sem mapa manual.
2. **Skills personalizadas** → **grant explícito** + arquivo central único (sem duplicar).

Ambos produzem uma **allowlist por agente** que alimenta o **filtro nativo do motor**.

## Arquitetura (núcleo agnóstico + adaptador fino)

- **Núcleo (agnóstico de provider):** `resolveAgentSkills(agentId) → string[]` = `baseline ∪ derivadas-de-permissão ∪ grants`. Uma função, independente do motor. É a **única** fonte da lista.
- **Adaptador de enforcement (por provider):** aplica a allowlist ao motor.
  - `claude` → `Options.skills` (nativo). ~10 LOC.
  - `codex` → materializar dir por agente (`CODEX_HOME` isolado). Adaptador separado, fase 2.
- **O SISTEMA NÃO é preso a provider.** Só o passo de *enforcement* varia. (Correção explícita da versão anterior, que tratava a feature inteira como "claude-only".)

## Estado atual (verificado no código, 2026-07-02)

- `discoverPlugins()` é **agent-blind** (`src/plugins/index.ts:121`) → todo agente recebe todas as skills compartilhadas, todo turno. Não há filtro por agente.
- **A alavanca existe nativa:** `Options.skills?: string[]` — *"only skills whose names match an entry are loaded into the main session system prompt"* (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3213-3216`). **Não está setado hoje** (`src/runtime/claude-provider.ts:buildClaudeQueryOptions`). Setá-lo com a allowlist resolvida É o filtro.
- **O mapa skill↔comando já existe:** `DEFAULT_RAVI_GROUP_SKILL_RULES` — 27 regras `{id, pattern, skill}` (`src/cli/skill-gates.ts:46-75`), ex.: `cron → ravi-system-cron-manager`.
- **A permissão por grupo já existe:** capability `execute:group:<grupo>`, materializável via `materializeSubjectCapabilities("agent", id)` (`src/permissions/provider-runtime.ts`; snapshot puro em `capability-snapshot.ts`).

## Pré-requisito real — por que o filtro é inerte hoje (verificado ao vivo 2026-07-03)

Teste em cópia isolada do estado real (56 agentes): **todo agente materializa `execute:group:*`** (coringa) — cravado em `runtime-bootstrap-provider.ts:58` (`materializeCapabilities` dá `execute:group:*` a todo subject agent/automation, provider `required:true`) — **mais** `admin:system:*` (profile full-access aplicado a todos). Com qualquer um dos dois, `resolveAgentSkills` deriva TODAS as skills → allowlist = tudo → **o filtro está correto mas não estreita nada hoje**.

Prova do mecanismo (mesma cópia, spike removendo o coringa do bootstrap): agente com só `execute:group:cron` → vê **7** skills (baseline + cron), não 28. `main` (admin) → 28. **O filtro corta certo quando a permissão é específica.**

**Direção (decisão RM 2026-07-03) — least-privilege:** pra o filtro ter efeito, o default de permissão MUST virar "nasce só com o **kit baseline (4)** e **opta-in** o resto" via `execute:group:<grupo>` específico. É **migração à parte** (não este PR), porque:
- `execute:group:*` gate **execução de comando**, não só visibilidade → apertar reduz o que o agente PODE FAZER (efeito desejado, mas blast radius real).
- 56 agentes dependem do coringa → migração MUST **grandfather** os existentes (congela caps atuais), trocar o default só pra **novos**, e apertar os existentes um a um.
- Há DOIS "pode tudo": o `execute:group:*` do bootstrap E o `admin:system:*` do full-access. Ambos MUST sair de quem não é admin, senão o filtro segue inerte.

Este PR (mecanismo `resolveAgentSkills` + enforcement + grant + `withLocalSkillsPreserved`) é **correto e seguro (inerte)** — com o default atual ninguém perde skill. Ele é o **pré-requisito** da migração, não o efeito.

## Mecanismo 1 — Skills de sistema DERIVADAS da permissão

O agente VÊ a skill de sistema do grupo `G` **se e só se** tem `execute:group:G` (ou `execute:group:*`). Derivado, **sem mapa manual, sem nova tabela**.
- Fonte: inverter `DEFAULT_RAVI_GROUP_SKILL_RULES` (skill→grupo) × grupos permitidos do agente (permissões materializadas).
- Muda a permissão → muda a skill visível, automático, no próximo turno.

## Mecanismo 2 — Skills personalizadas via grant + central

- Skill personalizada MUST viver **uma vez** num bucket central compartilhado (sem cópia por agente).
- Visibilidade por **mapa de grant** `skill → {agentes}`, gerenciável por `ravi skills grant/revoke/who`.
- A chave do agente no grant MUST ser o **id imutável** (rename não orfana grant).

## Baseline (kit essencial)

Todo agente — inclusive recém-criado — MUST receber automaticamente um baseline de `ravi-system:*` essenciais, independente de permissão/grant. Sem baseline, agente novo nasce inoperante.

**Kit = 4 (decisão RM 2026-07-03):** `sessions` (falar com outros/consigo), `tasks` (receber e reportar trabalho), `specs` (ler as regras que o governam), `skills`/skill-creator (criar/refinar as próprias skills). `specs` + `skills` são o par "definir como eu trabalho" (RM explicitou que skill-creation acompanha specs no comum).

`agents-manager` e `permissions-manager` (que estavam nos 6 originais) FORAM REMOVIDOS do baseline: são poderes de **admin**, não necessidade universal → viram condicionais (`execute:group:agents` / `execute:group:permissions`). Ler a própria config, se preciso, via caminho leve (`ravi self`), não pelo skill de gerência.

> Nota de implementação: `BASELINE_SYSTEM_SKILL_SLUGS` (`src/runtime/allowed-skills.ts`) ainda lista os 6. O corte 6→4 entra junto da migração least-privilege abaixo (não neste PR, que é inerte — mudar baseline hoje não tem efeito ao vivo).

## Invariants

- **R (fonte única).** A allowlist MUST vir só de `resolveAgentSkills` = `baseline ∪ derivadas-permissão ∪ grants`. Nada de outra origem.
- **T (por turno).** MUST ser resolvida na montagem de cada turno (`runtime-request-builder` → `claude-provider.buildClaudeQueryOptions`) → mudança de permissão/grant vale no **próximo turno, sem restart**.
- **N (agnóstico).** `resolveAgentSkills` MUST ser provider-agnostic. Só o *enforcement* (aplicar a lista ao motor) é por-provider. MUST NOT ramificar a lógica de resolução por provider.
- **D (derivação).** Visibilidade de skill `ravi-system:*` MUST ser derivada da permissão de comando (Mecanismo 1). MUST NOT existir mapa manual para skills de sistema.
- **B (baseline).** Todo agente MUST receber o baseline, sempre — mesmo sem permissão nenhuma.
- **U (single-source).** Skill personalizada MUST ter um único arquivo central; N grants MUST NOT duplicar arquivo em disco.
- **G (gate consistente).** Se o skill-gate entrega o corpo de uma skill, MUST respeitar a mesma allowlist do agente — MUST NOT resolver do catálogo global furando a visibilidade. Hoje `resolveSkillForGate` (`src/cli/skill-gate.ts`) resolve global; MUST passar a checar a allowlist.
- **F (no-break / fallback).** Allowlist ausente/vazia MUST cair no comportamento atual (todas as skills). A ativação MUST NOT quebrar agente existente (grandfather = comportamento antigo até haver config).
- **C (cache-friendly).** A allowlist SHOULD ser estável entre turnos do mesmo agente (recomputa, mas idêntica) → o prefixo do prompt mantém cache. SHOULD mudar só em mudança de permissão/grant.
- **S (não-sandbox).** É filtro de **índice**, NÃO segurança. A `SKILL.md` não-visível MAY continuar alcançável via Read/Bash; MUST NOT aparecer no índice/menu do agente. Documentar como não-objetivo.
- **L (colisão de nome).** Skill local do agente (`<agent-cwd>/.claude/skills/`) MUST ter precedência sobre a compartilhada de mesmo nome; a compartilhada MUST ser suprimida do índice desse agente na colisão.
- **CLI.** O grant MUST ser gerenciável por `ravi skills grant/revoke/who`; MUST NOT exigir edição manual de config.

## Implementação (ordenada, fácil)

1. **Exportar** helper que inverte as regras: `getGroupSkillMap()` (`src/cli/skill-gates.ts`) — hoje `DEFAULT_RAVI_GROUP_SKILL_RULES` é privado.
2. **`resolveAgentSkills(agentId)`** (novo módulo runtime, agnóstico) = `baseline ∪ (materializar caps → grupos → skills via mapa) ∪ (grants do agente)`.
3. **Ligar no build do turno:** passar `agentId`/allowlist por `src/runtime/runtime-request-builder.ts` (o `agent` já está disponível) → `src/runtime/claude-provider.ts:buildClaudeQueryOptions` → setar `Options.skills`. (~10 LOC + threading.)
4. **`ravi skills grant/revoke/who`** (`src/cli/commands/skills.ts`, ao lado de list/show/install/sync) + store do grant (tabela pequena em `.ravi/`).
5. **Bucket central** pras personalizadas = reusar `~/ravi/plugins/*` (compartilhado). O grant governa visibilidade; o arquivo fica onde está.
6. **Telemetria** (`src/runtime/skill-visibility.ts`) MUST ser construída da lista JÁ filtrada, não de `input.plugins` cru — senão reporta visibilidade falsa.

## Scope

- **Núcleo (resolver allowlist):** provider-agnostic, feito **uma vez**.
- **Enforcement v1:** `claude` via `Options.skills`. Subagents usam `AgentDefinition.skills` (`sdk.d.ts:1876-1897`) — propagar para agentes que usam Task/subagents (ex. `main`).
- **Enforcement `codex`:** fase 2 — dir por agente via `CODEX_HOME` isolado (hoje `~/.codex/skills` é global singleton, `codex-skills.ts`). O núcleo NÃO muda; só entra um adaptador.
- **`pi`:** sem surface de skill (`pi-provider.ts`) → no-op.

## Boundaries

- Filtro de índice, **não** sandbox (Invariant S).
- NÃO substitui permissions (REBAC de comandos) — as skills de sistema *seguem* a permissão, não a redefinem.
- NÃO cobre versionamento/distribuição de skills entre instâncias.

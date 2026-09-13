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
review: "v5 2026-09-13 — Pi aplica a allowlist no authorize path (tool-time), não só no catálogo do prompt."
---

<!-- markdownlint-disable-next-line MD025 -->
# Per-Agent Skill Visibility

## Intent

Cada agente vê no contexto **só as skills que fazem sentido pra ele** — resolvido **por agente, a cada turno**. Resolve 3 dores: poluição de índice (todas as skills em todos os agentes, todo turno), duplicação de skill personalizada, e falta de ownership.

**Dois regimes, um resultado:**

1. Agente com grants explícitos recebe `baseline ∪ grants`; permissões genéricas não ampliam esse catálogo.
2. Agente sem grants explícitos recebe `baseline ∪ derivadas-de-permissão`, preservando compatibilidade.

Ambos produzem uma **allowlist por agente** que alimenta o **filtro nativo do motor**.

## Arquitetura (núcleo agnóstico + adaptador fino)

- **Núcleo (agnóstico de provider):** `resolveAgentSkills(agentId)` produz a allowlist canônica. Uma função, independente do motor, é a única fonte da lista.
- **Adaptador de enforcement (por provider):** aplica a allowlist ao motor.
  - `claude` → `Options.skills` nativo, preservando skills locais autorizadas.
  - `codex` → `skills/list` nativo, catálogo lógico deduplicado e `skills.config` desabilitando toda entrada fora da allowlist.
  - `pi` → catálogo filtrado no prompt; `ravi skills show`, `Skill` e Read/Edit de `SKILL.md` passam pelo mesmo authorize path do permission extension (`canUseTool` / host `authorizeToolUse`). Skill fora da allowlist MUST falhar com `SKILL_NOT_AUTHORIZED`.
- **O SISTEMA NÃO é preso a provider.** Só o passo de *enforcement* varia. (Correção explícita da versão anterior, que tratava a feature inteira como "claude-only".)

## Estado atual v4 (validado em produção, 2026-09-11)

- `ravi-facade`, com 10 grants explícitos e baseline operacional, recebeu exatamente 14 skills lógicas no runtime Codex; antes recebia 251.
- Aliases físicos duplicados são reduzidos a uma entrada lógica. A cópia canônica é preferida e uma cópia disponível pode servir de fallback, como em `skill-creator`.
- `ravi skills show <não-concedida>` falha com `SKILL_NOT_AUTHORIZED` antes da execução do processo.
- Uma leitura concedida gera `skill.visibility.loaded` e aparece no `turn.complete.session.params.skillVisibility.loadedSkills`.
- Cold start e session resume mantêm o catálogo filtrado.
- O cold start observado caiu de 51.016 para 19.958 input tokens após remover o catálogo global.

## Baseline (kit essencial)

Todo agente — inclusive recém-criado — MUST receber automaticamente um baseline de `ravi-system:*` essenciais, independente de permissão/grant. Sem baseline, agente novo nasce inoperante.

**Kit = 4 (decisão RM 2026-07-03):** `sessions` (falar com outros/consigo), `tasks` (receber e reportar trabalho), `specs` (ler as regras que o governam), `skills`/skill-creator (criar/refinar as próprias skills). `specs` + `skills` são o par "definir como eu trabalho" (RM explicitou que skill-creation acompanha specs no comum).

`agents-manager` e `permissions-manager` não pertencem ao baseline: são poderes de administração, não necessidades universais.

## Invariants

- **R (fonte única).** A allowlist MUST vir só de `resolveAgentSkills`: `baseline ∪ grants` quando houver grants explícitos; caso contrário, `baseline ∪ derivadas-permissão`. Nada de outra origem.
- **T (por turno).** MUST ser resolvida na montagem de cada turno pelo `runtime-request-builder` e entregue ao adaptador do provider. Mudança de permissão ou grant vale no próximo turno, sem restart.
- **N (agnóstico).** `resolveAgentSkills` MUST ser provider-agnostic. Só o *enforcement* (aplicar a lista ao motor) é por-provider. MUST NOT ramificar a lógica de resolução por provider.
- **D (derivação compatível).** A derivação por permissão MUST ser usada apenas quando o agente não tiver grants explícitos. Um grant explícito MUST NOT ser ampliado por uma permissão genérica.
- **B (baseline).** Todo agente MUST receber o baseline, sempre — mesmo sem permissão nenhuma.
- **U (single-source).** Skill personalizada MUST ter um único arquivo central; N grants MUST NOT duplicar arquivo em disco.
- **G (gate consistente).** Toda entrega de uma skill, inclusive skill-gate e `ravi skills show`, MUST respeitar a mesma allowlist do agente. Uma skill não concedida MUST falhar com `SKILL_NOT_AUTHORIZED`.
- **F (no-break / fallback).** Agente sem configuração explícita mantém a derivação compatível. Agente configurado com grants explícitos MUST receber somente baseline e grants.
- **C (cache-friendly).** A allowlist SHOULD ser estável entre turnos do mesmo agente (recomputa, mas idêntica) → o prefixo do prompt mantém cache. SHOULD mudar só em mudança de permissão/grant.
- **S (camadas independentes).** Visibilidade de skill e permissão de ferramenta são controles distintos. O catálogo e `ravi skills show` MUST aplicar a allowlist; capacidades de efeito continuam sendo autorizadas pela camada de ferramentas.
- **L (colisão de nome).** Skill local do agente (`<agent-cwd>/.claude/skills/`) MUST ter precedência sobre a compartilhada de mesmo nome; a compartilhada MUST ser suprimida do índice desse agente na colisão.
- **CLI.** O grant MUST ser gerenciável por `ravi skills grant/revoke/who`; MUST NOT exigir edição manual de config.

## Implementação vigente

1. `runtime-request-builder` resolve a allowlist antes de iniciar ou retomar o turno e rejeita resume incompatível.
2. Cada provider recebe `allowedSkills` e aplica seu adaptador sem duplicar a regra de resolução.
3. O Codex consulta o inventário nativo, seleciona uma cópia por nome lógico e desabilita o restante antes de `thread/start`, `thread/resume` ou `thread/fork`.
4. O CLI e o host autorizam `skills show` contra o agente da sessão atual.
5. O host converte a skill lida de volta ao alias anunciado e persiste a evidência no snapshot do turno.
6. No Pi, o permission extension chama `authorizePiToolCall` antes de qualquer tool. Além do REBAC e do Bash `authorizeCommandExecution`, o authorize path aplica a allowlist a invocações de skill (Skill tool, `ravi skills show`, Read/Edit de `skills/<name>/SKILL.md`). Filtrar o catálogo no prompt NÃO é a barreira de segurança.

## Scope

- **Núcleo (resolver allowlist):** provider-agnostic, feito **uma vez**.
- **Enforcement:** Claude, Codex e Pi usam a mesma allowlist canônica, com adaptação apenas na superfície de cada provider.
- **Telemetria:** catálogo anunciado e leituras observadas fazem parte do estado persistido e do trace terminal.

## Boundaries

- O controle protege catálogo e leitura pela interface Ravi e, no Pi, a invocação via tool no authorize path; não transforma instruções em permissões de efeito.
- NÃO substitui permissions (REBAC de comandos) — as skills de sistema *seguem* a permissão, não a redefinem.
- NÃO cobre versionamento/distribuição de skills entre instâncias.

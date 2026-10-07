# Per-Agent Skill Visibility / CHECKS

Cenários de aceite verificáveis. Cada um MUST passar antes de GA.

## Revisão v4 — validada em produção em 2026-09-11

- [x] Agente com 10 grants recebe 10 grants + 4 skills de baseline, não o catálogo global.
- [x] `skillVisibility.skills` coincide com a allowlist lógica efetiva.
- [x] `ravi skills show <não-concedida>` retorna `SKILL_NOT_AUTHORIZED`.
- [x] `ravi skills show <concedida>` retorna o conteúdo normalmente.
- [x] A leitura concedida aparece em `loadedSkills` no evento `turn.complete`.
- [x] Aliases físicos duplicados produzem uma única skill lógica anunciada.
- [x] Cold start e session resume preservam o catálogo filtrado.
- [x] A redução do catálogo diminui os input tokens do cold start de forma mensurável.
- [x] Permissões de ferramentas continuam independentes da visibilidade de skills.
- [x] Identidade com `admin:system:*` (e opcionalmente `mutate:permissions:allow`) + grant personalizado MUST ver `ravi-system-permissions-manager` e NÃO ser bloqueada por `RAVI_SKILL_GATE_CONFIG_ERROR` em `ravi permissions --help` / `permissions_allow` / `ravi skills show`.
- [x] Identidade com `mutate:pages:ship` + grant personalizado MUST ver `ravi-system-pages`.
- [x] Identidade sem essas capabilities MUST continuar `SKILL_NOT_AUTHORIZED` / `RAVI_SKILL_GATE_CONFIG_ERROR`.
- [x] Grant da skill `permissions-manager` MUST NOT conceder `mutate:permissions:allow`.
- [x] Pi: Read/`Skill` de skill não concedida é negado no permission-extension authorize path com `SKILL_NOT_AUTHORIZED`.
- [x] Pi: Read/`Skill` de skill concedida é autorizado; arquivos comuns (ex. `README.md`) não disparam o gate.
- [x] Pi: o catálogo do system prompt continua filtrado pela mesma allowlist.

## Revisão v5 — bug `2b7fcc09` (anúncio × gate × install)

- [x] `SKILL_NOT_AUTHORIZED` nomeia skill e agente (`Skill 'x' is not authorized for agent 'y'.`) nos três pontos (Pi extension, host Bash/tool, `ravi skills show`) e aponta `skills install --source` + `skills grant` (desde a v7, `install` só para skill fora do Ravi). Coberto por `skill-capability-visibility.test.ts` e `skills.test.ts`.
- [x] Pi com allowlist sobe com `--no-skills`: `~/.agents/skills/<x>` não aparece mais no `available_skills` nativo; sem allowlist o flag não é passado. Coberto por `pi-provider.test.ts` + controle ao vivo com Pi 0.73.1 (`get_commands`: `["skill:find-skills"]` → `[]`).
- [x] Loop fechado: skill só em `~/.agents/skills/find-skills` → `grant` falha `SKILL_NOT_FOUND` apontando `install --source` → `ravi skills install --source ~/.agents/skills/find-skills` (sem nome) → `grant` → Read autorizado; `other-skill` do mesmo diretório segue negada. Coberto por `skills.test.ts`.
- [x] Nenhuma entrada de `~/.agents/skills` é concedida automaticamente.
- [x] Linha com skill concedida + não concedida (`head <negada>/SKILL.md; cat <concedida>/SKILL.md`) é negada nomeando a não concedida, no host e no Pi. Antes a linha passava porque só a primeira referência resolvida era checada. Coberto por `skills.test.ts`, `pi-tool-permissions.test.ts` e `skill-visibility.test.ts`.
- [x] `ravi skills install --source ~/.agents/skills/<x>/SKILL.md` não dispara `SKILL_NOT_AUTHORIZED`; `cat ~/.agents/skills/<x>/SKILL.md` continua negado.

## Revisão v7 — full-access sem acesso à skill `bases` (2026-10-07)

- [x] Agente `full-access` MUST ler `bases` (`bases`, `ravi-system-bases`, `ravi-system:bases`) e skills do catálogo sem regra de gate (ex.: `crm-manager`, `app-creator`) via `ravi skills show`, host Bash/tool e Pi. Coberto por `skill-capability-visibility.test.ts`.
- [x] O profile `full-access` MUST materializar `use:skill:*`. Coberto por `provider-runtime.test.ts`.
- [x] Skill que só existe no disco MUST continuar negada mesmo para `admin:system:*`. Coberto por `skill-capability-visibility.test.ts` e `skills.test.ts`.
- [x] `use:skill:<id>` concreto MUST autorizar a skill por qualquer alias (`ravi-system:bases` ↔ `bases`) e entrar na allowlist como grant; glob (`use:skill:ravi-dev-*`) e `use:skill:*` MUST autorizar a leitura sem ampliar a allowlist; `execute:skill:*` e `read:skill:*` MUST NOT autorizar. Coberto por `skill-capability-visibility.test.ts`.
- [x] A primeira chamada `ravi bases …` MUST devolver `RAVI_SKILL_REQUIRED` com `ravi-system-bases`, e o retry MUST passar. Coberto por `skill-capability-visibility.test.ts` e `registry-snapshot.test.ts`.
- [x] `SKILL_NOT_AUTHORIZED` de skill do catálogo MUST NOT sugerir `skills install`; skill fora do Ravi MUST sugerir `install --source` + `grant`. Coberto por `skills.test.ts`, `skill-capability-visibility.test.ts` e `pi-tool-permissions.test.ts`.
- [x] Linha que encadeia `ravi skills grant …` com a leitura negada MUST dizer que a linha foi rejeitada inteira e que o grant deve rodar sozinho. Coberto por `skill-capability-visibility.test.ts` e `skill-visibility.test.ts`.
- [x] Skill lida sob demanda (state `loaded`) fora da allowlist que o gate autoriza MUST NOT impedir o resume; skill anunciada fora da allowlist continua impedindo. Coberto por `skill-visibility.test.ts`.
- [x] Turno com capabilities efetivas estreitadas (overlay de chat sem `use:skill:*`) MUST negar a skill para um agente `full-access`, sem cair para as capabilities do agente. Coberto por `skill-capability-visibility.test.ts`.
- [x] `ravi skills show <nome> --source <dir>` apontando para o diretório de uma skill instalada no Ravi MUST ser autorizado por grant, `use:skill:*` e `admin:system:*`; conteúdo de mesmo nome de outro diretório (ou com nome de skill do catálogo) MUST NOT ser autorizado por nenhum deles nem pela implicação por capability de comando, e a negação diz que o conteúdo do `--source` não é a skill do Ravi. Coberto por `skill-capability-visibility.test.ts`.
- [x] Agente cuja única configuração é `use:skill:*` MUST contar como configurado: lê skills do catálogo e instaladas, e skill só do disco MUST NOT ser autorizada por fallback (Invariant F). Coberto por `skill-capability-visibility.test.ts`.

## Cenários herdados

### Núcleo v3 (derivação + agnóstico)

- [ ] **C-D (derivação da permissão — o coração):** agente com permissão só de `execute:group:cron` + `execute:group:tasks` vê no índice SÓ as skills de sistema `cron` + `tasks` (+ baseline) — não as outras 28. Verificar via a allowlist resolvida / `Options.skills`. **Sem grant manual.**
- [ ] **C-D2 (segue a permissão, vivo):** dar `execute:group:crm` ao agente → no PRÓXIMO turno ele vê `ravi-system-crm`. Revogar → some no próximo turno. Sem restart, sem grant.
- [ ] **C-N (agnóstico):** `resolveAgentSkills(agentId)` retorna a mesma lista independente do provider configurado. Só o enforcement difere. (Testável isolando a função.)

### Personalizadas (grant + central)

- [ ] **C1 (visibilidade seletiva):** `ravi skills grant gmail-pack jarvis-financ` + `... jarvis-cobranca`. Os dois veem no índice; `book-promo` (sem grant) não.
- [ ] **C-U (fonte única):** editar `gmail-pack` num único lugar reflete nos dois liberados, sem cópia física.

### Bloqueadores (regressão obrigatória)

- [ ] **C-B (baseline):** agente novo do zero vê o baseline (agents/sessions/tasks/permissions/skills/specs) imediatamente, sem grant, e opera o runtime.
- [ ] **C-F (no-break):** ligar a feature com config ausente → todo agente continua vendo todas as skills (comportamento atual). Ninguém perde skill no rollout.
- [ ] **C-local (skills da própria pasta do agente — o F1):** agente com allowlist ATIVA (ex.: `main`, que tem `admin:system:*`) NÃO perde as skills locais de `<cwd>/.claude/skills/` (swarm-orchestrator, devils-advocate, managing-vault…). Motivo: `Options.skills`, quando setado, filtra TODA skill descoberta — plugins E locais. O núcleo `resolveAgentSkills` é agnóstico e não conhece essas fontes de filesystem, então o adapter (claude) UNE as locais à allowlist antes do filtro nativo (`withLocalSkillsPreserved`). Sem esse union, o agente nasceria cego pro próprio arsenal. Regressão coberta por `src/runtime/claude-local-skills.test.ts`.
- [ ] **C-G (gate respeita allowlist):** agente cuja allowlist NÃO inclui `ravi-system-whatsapp-manager` dispara o gate `whatsapp` → o gate NÃO entrega o corpo (não resolve do catálogo global). Repetir para os 30 default gates.
- [ ] **C-L (colisão):** agente com skill local `foo` + compartilhada `foo` → a local ganha; a compartilhada some do índice desse agente.

### Edge / higiene

- [ ] **C-rev (revoke mid-sessão):** revogar → some do índice no próximo turno; corpo já carregado não é evictado no turno corrente. Documentado.
- [ ] **C-orphan:** `grant` de skill inexistente falha (fail-fast); deletar agente/skill limpa grants; `who` sinaliza órfãos.
- [ ] **C-T (telemetria):** o snapshot reporta como visível só a lista JÁ filtrada, não `input.plugins` cru.
- [ ] **C-sub (subagents):** agente que usa Task propaga a allowlist via `AgentDefinition.skills` (não vaza catálogo inteiro pro subagent).
- [ ] **C-cache:** allowlist idêntica entre turnos de um agente inalterado → sem quebra de cache de prompt atribuível ao filtro (verificável no tracking de custo).

### Histórico v3

- O v3 tratava Codex e Pi como fases futuras. A revisão v4 substitui esse limite e exige enforcement nos três providers.

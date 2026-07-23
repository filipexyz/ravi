# Per-Agent Skill Visibility / CHECKS

Cenários de aceite verificáveis. Cada um MUST passar antes de GA.

## Núcleo v3 (derivação + agnóstico)

- [ ] **C-D (derivação da permissão — o coração):** agente com permissão só de `execute:group:cron` + `execute:group:tasks` vê no índice SÓ as skills de sistema `cron` + `tasks` (+ baseline) — não as outras 25. Verificar via a allowlist resolvida / `Options.skills`. **Sem grant manual.**
- [ ] **C-D2 (segue a permissão, vivo):** dar `execute:group:crm` ao agente → no PRÓXIMO turno ele vê `ravi-system-crm`. Revogar → some no próximo turno. Sem restart, sem grant.
- [ ] **C-N (agnóstico):** `resolveAgentSkills(agentId)` retorna a mesma lista independente do provider configurado. Só o enforcement difere. (Testável isolando a função.)

## Personalizadas (grant + central)

- [ ] **C1 (visibilidade seletiva):** `ravi skills grant gmail-pack jarvis-financ` + `... jarvis-cobranca`. Os dois veem no índice; `book-promo` (sem grant) não.
- [ ] **C-U (fonte única):** editar `gmail-pack` num único lugar reflete nos dois liberados, sem cópia física.

## Bloqueadores (regressão obrigatória)

- [ ] **C-B (baseline):** agente novo do zero vê o baseline (agents/sessions/tasks/permissions/skills/specs) imediatamente, sem grant, e opera o runtime.
- [ ] **C-F (no-break):** ligar a feature com config ausente → todo agente continua vendo todas as skills (comportamento atual). Ninguém perde skill no rollout.
- [ ] **C-local (skills da própria pasta do agente — o F1):** agente com allowlist ATIVA (ex.: `main`, que tem `admin:system:*`) NÃO perde as skills locais de `<cwd>/.claude/skills/` (swarm-orchestrator, devils-advocate, managing-vault…). Motivo: `Options.skills`, quando setado, filtra TODA skill descoberta — plugins E locais. O núcleo `resolveAgentSkills` é agnóstico e não conhece essas fontes de filesystem, então o adapter (claude) UNE as locais à allowlist antes do filtro nativo (`withLocalSkillsPreserved`). Sem esse union, o agente nasceria cego pro próprio arsenal. Regressão coberta por `src/runtime/claude-local-skills.test.ts`.
- [ ] **C-G (gate respeita allowlist):** agente cuja allowlist NÃO inclui `ravi-system-whatsapp-manager` dispara o gate `whatsapp` → o gate NÃO entrega o corpo (não resolve do catálogo global). Repetir para os 27 default gates.
- [ ] **C-L (colisão):** agente com skill local `foo` + compartilhada `foo` → a local ganha; a compartilhada some do índice desse agente.

## Edge / higiene

- [ ] **C-rev (revoke mid-sessão):** revogar → some do índice no próximo turno; corpo já carregado não é evictado no turno corrente. Documentado.
- [ ] **C-orphan:** `grant` de skill inexistente falha (fail-fast); deletar agente/skill limpa grants; `who` sinaliza órfãos.
- [ ] **C-T (telemetria):** o snapshot reporta como visível só a lista JÁ filtrada, não `input.plugins` cru.
- [ ] **C-sub (subagents):** agente que usa Task propaga a allowlist via `AgentDefinition.skills` (não vaza catálogo inteiro pro subagent).
- [ ] **C-cache:** allowlist idêntica entre turnos de um agente inalterado → sem quebra de cache de prompt atribuível ao filtro (verificável no tracking de custo).

## Não-objetivos (documentar, não testar como falha)

- **Não-sandbox:** `SKILL.md` não-visível ainda alcançável via Read/Bash (filtro de índice). Confirmar documentado, não bloqueado.
- **Enforcement codex/pi:** fora do v1 de enforcement. Confirmar que o NÚCLEO (resolução) roda igual e que o adaptador codex está declarado como fase 2 (não testar per-agent no codex ainda).

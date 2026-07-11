# Per-Agent Skill Visibility / WHY

## Origem

Discussão RM × main em 2026-07-02. Pain estrutural: (1) todas as skills do `ravi skills` entram no contexto de TODO agente, todo turno — mesmo sem permissão pra aquelas ferramentas → poluição; (2) uma skill personalizada útil a 2 agentes precisa ser duplicada em cada pasta. RM pediu: "o sistema disponibiliza só as skills que o agente PRECISA" + "uma central de skills personalizadas reutilizáveis".

## Decisão v3 (KISS) — supera a v2

A v2 usava um **mapa manual `skill → {agentes}` para TODAS as skills** e travava o escopo em **claude-only**. A v3 corrige os dois:

1. **Skill de sistema NÃO precisa de mapa manual — DERIVA da permissão.** O agente já tem (ou não) permissão pra rodar `ravi cron`, e já existe `DEFAULT_RAVI_GROUP_SKILL_RULES` ligando skill↔comando. Logo "quais skills de sistema esse agente vê" **já está codificado nas permissões** — cruzar as duas fontes é barato e não pede tabela nova. Um mapa manual paralelo **duplicaria a verdade da permissão** e sairia de sincronia.

2. **O sistema é provider-agnostic; só o enforcement é por-provider.** A v2 tratava a feature como "claude-only", dando a impressão de que é presa a um motor. Não é: `resolveAgentSkills(agentId)` (calcular a lista) é agnóstico, feito uma vez; o "como aplicar a lista" é um adaptador fino (claude = `Options.skills` nativo; codex = dir por agente). RM corrigiu isso explicitamente.

Resultado: **grant manual sobra só para skills PERSONALIZADAS** (sem comando associado). Menos código, menos estado, menos divergência.

## Alternativas consideradas

- **A. Symlink** — mitigação de duplicação, mas sem CLI/ownership. Descartada como solução.
- **B. Mapa manual para TUDO (v2)** — resolve as dores, mas duplica a verdade da permissão para skills de sistema. **Rebaixada:** vale só para personalizadas.
- **B′ (v3). Derivar sistema da permissão + grant só para personalizadas** — RECOMENDADO. Fonte única (permissão), zero tabela nova para sistema, grant mínimo para custom.
- **C. Buckets por agente** — granularidade grossa; evolução futura se o volume justificar.

## Por que é barato (verificado no código)

- Filtro nativo: `Options.skills` (`sdk.d.ts:3213-3216`), não setado hoje → ~10 LOC pra ligar.
- Derivação reusa dados existentes: `DEFAULT_RAVI_GROUP_SKILL_RULES` (27 regras, `skill-gates.ts`) × permissões materializadas. Sem tabela nova.
- Latência: o prompt **encolhe** (menos skills injetadas) → tende a ser mais rápido e mais barato, não mais lento.

## Herança da revisão adversarial (v2) — o que continua valendo

Dos 5 bloqueadores da v2, continuam como invariants na v3:
- **Gate respeita a allowlist** (Invariant G) — senão fura a visibilidade.
- **Baseline core obrigatório** (Invariant B) — senão agente novo nasce cego.
- **No-break/grandfather** (Invariant F) — allowlist ausente = comportamento atual.
- **Não-sandbox** (Invariant S) — filtro de índice, não segurança.

Os pontos "mapa manual para tudo" e "claude-only" foram **superados** pela decisão v3 (derivação da permissão + núcleo agnóstico).

## Decisões de produto ainda abertas (RM)

1. **Skills personalizadas por tag/grupo** já no v1, ou grant 1-a-1 primeiro?
2. **Central das personalizadas:** um bucket compartilhado só, ou por área?

(As "4 decisões" da v2 caíram para 2: Claude-só e o baseline já estão resolvidos — baseline é fixo, e o escopo deixou de ser "escolher provider".)

## Prioridade

Prioritária (RM, 2026-07-02): bloqueador estrutural pra escalar o nº de skills sem degradar o contexto de todos os agentes.

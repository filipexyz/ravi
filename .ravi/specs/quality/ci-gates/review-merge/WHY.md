---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Rationale"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: archived
---

## RETIRED — 2026-11-04 (decisão do operador)

Este gate **não está em vigor**. O workflow `.github/workflows/review-gate.yml` foi removido de `dev` e o ruleset que o tornava obrigatório já havia sido deletado em 2026-10-31. Nada neste spec deve ser tratado como requisito de merge.

Regras válidas hoje:
- Nenhum check de review é obrigatório. Em `dev` o único status obrigatório é `Quality Gate`.
- Revisão independente continua sendo **disciplina escrita no corpo do PR**, não um check que bloqueia.
- NÃO reintroduzir este gate, o workflow, o ruleset ou um "machine user" aprovador sem pedido explícito do operador. Reativar por conta própria já falhou e é considerado defeito.
- O código (`src/ci/review-gate.cjs`, testes, `.github/review-gate-ruleset.json`) fica no repositório apenas como material inerte, para o dia em que o operador quiser retomar.

O restante deste documento descreve o desenho original, mantido para memória. Nenhuma linha abaixo é normativa enquanto este status for `archived`.


# Why this gate exists

PRs #767 and #756 were reported merged with unresolved security findings and without independent approvals. Successful build checks do not establish that review findings were addressed.

The API check supplies verifiable review evidence and a SHA-bound audit trail. Native GitHub rules supply enforcement at merge time, including changes to thread state that do not trigger Actions. Both are required: polling alone leaves stale success windows, and conversation resolution alone is not an independent review.

The policy intentionally blocks the current single-collaborator setup. As of initial rollout, `filipexyz` was the only collaborator and had admin access. A second GitHub identity with write access is needed to approve its PRs. We do not invite users or expand access as part of installing this gate.

A read-only `pull_request` workflow can be tested before merging the gate itself, with no deployment, elevated target workflow, secret or daemon restart. A writer can edit its definition; native independent review still prevents that writer from releasing its own change. An isolated check publisher would improve this boundary, but requires separately governed credentials/installation and is not silently provisioned here.

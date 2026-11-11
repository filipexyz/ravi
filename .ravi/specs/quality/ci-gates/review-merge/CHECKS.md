---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Checks"
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


# Verification

Run `bun test src/ci/review-gate.test.ts` (no install, full build or full suite needed).

- Open thread + valid independent head approval: blocks.
- Resolved thread + valid independent head approval: passes.
- HTTP 403/429/500, network/GraphQL errors, malformed or incomplete response: blocks.
- New head with approval on old head: blocks. Previously resolved threads do not rescue it.
- Outdated unresolved thread, later changes requested, author/bot/reader approval: blocks.
- Missing/blank/self/stale/automatic finding dismissal: blocks.
- Justified independent dismissal: audit includes actor, reason, SHA and source URL; unresolved thread still blocks.
- New independent head approval explicitly renewing a justified dismissal: passes once resolved.
- Pagination to page two finds a blocker; malformed cursor or truncated count blocks.
- Head or evidence changes between reads: blocks.

On the PR, inspect `Review Gate Tests` and the live `Review Gate` logs. A live gate failure for missing independent approval is expected with one collaborator; never manufacture an approval to make the check green. Fixture success is not a live second-identity approval.

Inspect the active ruleset by REST readback and `gh api repos/filipexyz/ravi/rules/branches/dev`. Both named checks must appear with integration 15368; required approvals, stale dismissal, last-push approval and conversation resolution must be enabled. Verify `bypass_actors` is empty. Check PR `reviewDecision`/`mergeStateStatus`; do not attempt a merge as a test.

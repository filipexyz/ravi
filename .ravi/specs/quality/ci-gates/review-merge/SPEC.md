---
id: quality/ci-gates/review-merge
title: "Review Merge Gate"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: archived
normative: false
applies_to:
  - src/ci/review-gate.cjs
  - src/ci/review-gate.test.ts
  - .github/workflows/review-gate.yml
  - .github/review-gate-ruleset.json
---

## RETIRED — 2026-11-04 (decisão do operador)

Este gate **não está em vigor**. O workflow `.github/workflows/review-gate.yml` foi removido de `dev` e o ruleset que o tornava obrigatório já havia sido deletado em 2026-10-31. Nada neste spec deve ser tratado como requisito de merge.

Regras válidas hoje:
- Nenhum check de review é obrigatório. Em `dev` o único status obrigatório é `Quality Gate`.
- Revisão independente continua sendo **disciplina escrita no corpo do PR**, não um check que bloqueia.
- NÃO reintroduzir este gate, o workflow, o ruleset ou um "machine user" aprovador sem pedido explícito do operador. Reativar por conta própria já falhou e é considerado defeito.
- O código (`src/ci/review-gate.cjs`, testes, `.github/review-gate-ruleset.json`) fica no repositório apenas como material inerte, para o dia em que o operador quiser retomar.

O restante deste documento descreve o desenho original, mantido para memória. Nenhuma linha abaixo é normativa enquanto este status for `archived`.

### Confirmação pós-merge — 2026-11-04 18:16 BRT

- `#805` mergeado em `dev` como squash `c7cf7ce` (`c7cf7ce60a3d961d79f0ce104003a849a4b12911`).
- `.github/workflows/review-gate.yml` não existe mais em `dev`: a listagem de workflows do repositório traz apenas `CI`, `PR Description`, `Release`, `SDK Release`, `Deploy Site` e `Version And Publish`.
- Nenhum check `Review Gate` / `Review Gate Tests` volta a aparecer em PR nova; o estado anterior era `disabled_manually`, agora o workflow não existe.
- Verificado por leitura direta da árvore de `dev` e da API de Actions em 04/11/2026 18:20 BRT.


# Review Merge Gate

## Contract

- `Review Gate` and `Review Gate Tests` MUST be required checks on `dev`, bound to the GitHub Actions integration (15368). The additive ruleset MUST have no bypass actors.
- The platform MUST require a PR, one independent approval, stale approval dismissal on push, approval of the last push by another identity, and resolution of all conversations. Missing checks MUST block merging.
- The evaluator MUST query GitHub's API, paginate every thread, review and timeline page, and verify head SHA, explicit counts, nodes and pagination. HTTP/network/auth/GraphQL errors, nulls, partial results and inconsistent snapshots MUST fail closed. An explicit complete zero-thread result is valid; absence of data is not.
- Every unresolved review thread MUST block, including outdated threads. Neither a green build, a dismissed review nor a severity label waives an open thread.
- A successful evaluation MUST have a latest effective `APPROVED` review by a non-author human identity with current write/maintain/admin access, whose review commit equals the event's exact head SHA. Bots, the PR author and reader approvals MUST NOT qualify.
- A push MUST invalidate the old approval and the attestation of previously resolved findings. A fresh independent approval on the new head is required even when GitHub retains the thread's resolved bit.
- The gate MUST re-read the head and all evidence before success. Changing head or review evidence during evaluation MUST fail, requiring another run.
- A manually dismissed review carrying a finding MUST have a native `ReviewDismissedEvent` with independent actor, technical justification, timestamp, URL and explicit SHA. The thread MUST also be resolved and there MUST still be an independent approval. Empty/generic unstructured dismissal messages MUST NOT qualify.
- A stale dismissal can only be renewed by a new independent approval on the new SHA explicitly referencing the original dismissal event with a fresh justification. Native automatic dismissal of stale approvals is not a finding waiver.
- Tests MUST cover open/resolved/API-failure/new-push scenarios independently of live credentials.

## Trust boundary

The workflow executes PR code with read-only GitHub permissions and installs no project dependencies. It MUST NOT receive write credentials or repository secrets. It is reviewable repository policy, not an independently administered GitHub App.

Binding a required check to GitHub Actions does **not** bind it to a particular workflow file. A writer can propose a workflow that reports the same name, but still cannot self-approve the required native review. Administrators can edit the ruleset itself. Stronger guarantees against a malicious writer plus colluding reviewer, or against the repository owner, require a separately governed GitHub App/required workflow and organization-level policy. Do not claim these guarantees exist in a personal repository.

GitHub Actions has no `pull_request_review_thread` trigger. Native conversation-resolution and review rules MUST remain enabled to prevent a cached success from permitting merge after a thread is reopened or an approval is dismissed. After resolving a thread, re-run the failed gate on the current PR commit (or submit the final current-head approval).

# Cenario INC-1 - not-found tipado em mutacoes CRM

## Objetivo

Validar que mutacoes CRM sobre alvo inexistente falham antes do efeito com erro
tipado e acionavel, sem alterar o caminho feliz da versao de producao
`v3.260817.2`.

## Baseline

- Fonte e binario de referencia: tag `v3.260817.2`, commit `b6046936`.
- Comportamento observado em producao para ST12-ST14: exit `1`, codigo
  `UNHANDLED_ERROR` e zero escrita.
- Simetria ja existente em leituras: erros `*_NOT_FOUND` com
  `suggestedAction`.

## Matriz

| Caso | Operacao | Alvo ausente | Codigo esperado |
| --- | --- | --- | --- |
| T1 | `task done` | task | `CRM_TASK_NOT_FOUND` |
| T2 | `task cancel` | task | `CRM_TASK_NOT_FOUND` |
| T3 | `task snooze` | task | `CRM_TASK_NOT_FOUND` |
| T4 | `opportunity move` | opportunity | `OPPORTUNITY_NOT_FOUND` |
| T5 | `fact confirm` | fact | `CRM_FACT_NOT_FOUND` |
| T6 | `fact reject` | fact | `CRM_FACT_NOT_FOUND` |
| T7 | `contact set` | contact | `CONTACT_NOT_FOUND` |
| T8 | `account link-contact` | account ou contact | codigo do alvo ausente |
| T9 | `opportunity link-contact` | opportunity, account ou contact | codigo do alvo ausente |

## Criterios de aceite

- Cada caso ausente retorna envelope `success:false`, exit `1`, codigo tipado,
  `retryable:false` e `suggestedAction` executavel.
- O mutator correspondente nao e chamado quando qualquer pre-condicao falha.
- Alvo oculto pela politica de visibilidade recebe o mesmo not-found e nao vaza
  existencia.
- Os caminhos felizes existentes continuam retornando o mesmo payload e chamam
  o mutator exatamente uma vez.
- Typecheck, teste focado e build passam sobre a tag de producao.
- Na VPS, ST12-ST14 passam contra o binario instalado e o readback confirma a
  mesma versao/commit promovida.

## Estresse

- Task vinculada a contato oculto.
- Alvo secundario ausente em `link-contact`.
- Execucao repetida do mesmo caso ausente.
- JSON parseavel sem texto adicional em stdout.

## Stop conditions

- Qualquer chamada de mutator em caso ausente ou oculto.
- Mudanca de payload no caminho feliz.
- Divergencia entre bundle testado e bundle instalado.
- Falha de rollback ou impossibilidade de confirmar a versao ativa.

# Resultados INC-1 - not-found tipado em mutacoes CRM

## Veredito

`PASS` para implementacao e producao. O bundle promovido preserva o caminho
feliz, bloqueia alvos ausentes/ocultos antes do mutator e esta ativo na VPS.

O status formal da implementacao permanece `BUILD_CANDIDATE`: esta sessao
executou comparadores e readbacks independentes do mutator, mas nao houve um
segundo avaliador humano/agente para declarar `INDEPENDENTLY_VERIFIED`.

## Baseline

- Fonte: `v3.260817.2`, commit `b6046936`.
- Teste CRM antes do patch: `24 pass`, `0 fail`, `120 expect()`.
- Producao antes do patch: ST12-ST14 retornavam `UNHANDLED_ERROR` conforme o
  dossie de avaliacao.

## Implementacao

- Contrato e cenario: `405df4b`.
- Not-found tipado e preflight de mutacoes: `1aa6f5d`.
- Runner E2E e postmortem de pack: `7b632ce`.
- Contencao de visibilidade em opportunity: `d102494`.

## Verificacoes locais

| Verificacao | Resultado |
| --- | --- |
| `bun test src/cli/commands/crm.test.ts` | `29 pass`, `0 fail`, `212 expect()` |
| `bun test src/contacts.identity-model.test.ts` | `42 pass`, `0 fail`, `265 expect()` |
| `bun run typecheck` | PASS |
| Biome nos tres arquivos tocados | PASS |
| `bun run build` | PASS; CLI, TUI e plugins gerados |

## E2E isolado na VPS

O pacote foi instalado em prefixo temporario e executado com
`RAVI_STATE_DIR` descartavel. O runner registrou:

- ST12 `CRM_FACT_NOT_FOUND`: PASS.
- ST13 `CRM_TASK_NOT_FOUND`: PASS.
- ST14 `OPPORTUNITY_NOT_FOUND` sem `suggestions`: PASS.
- Criacao de account e task: PASS.
- Transicao `task done`: PASS.
- Readback por `task show` com status `done`: PASS.

## Producao

- Pacote ativo: `ravi.bot@3.260817.2`.
- SHA-256 do artefato: `0d1f640d400253d3cbb9584c54af09a6d52cbf5b2234c2c0eb277e749d430fc2`.
- SHA-256 do bundle ativo: `6e2aad5a4af7ca321a510042ac116fd2def3f96a3838421b0c911426389ba4c5`.
- ST12, ST13 e ST14: PASS com exit `1`, codigo tipado, `retryable:false` e
  `suggestedAction`.
- `opportunity move` ausente: zero campo `suggestions`.
- Leitura real `crm task list --limit 1 --json`: `CRM_READ_OK`.

## Rollback

Backup anterior:

`/home/ravi/.ravi/backups/ravi.bot-3.260817.2-b6046936-pre-inc1.tgz`

SHA-256:

`f540ea6c3418c661a133904de67fb6837a031494c862b912fd8de8090711c1fe`

O rollback operacional reinstala o pacote publicado `ravi.bot@3.260817.2` ou
restaura o backup acima e confirma o hash anterior
`79356d5da4d9756d70a3fe8a8544943dee2b68779d1ee653005ca06a6a84080a`.

## Risco residual

O `npm audit` do prefixo temporario reportou 23 vulnerabilidades transitivas
(3 baixas e 20 moderadas). Elas pertencem ao conjunto de dependencias da mesma
versao-base e nao foram alteradas neste slice; exigem triagem separada.

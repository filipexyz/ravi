---
id: apps/gmail
title: "Gmail Ravi App"
kind: capability
domain: apps
capabilities:
  - gmail
  - ravi-app
  - google
  - email
tags:
  - apps
  - gmail
  - migration
applies_to:
  - src/apps/gmail
  - src/cli/commands/gmail.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Gmail Ravi App

## Intent

Registrar o Gmail como Ravi App nativo sem depender do SDE e sem incorporar o
onboarding de credenciais na primeira entrega. O legado continua disponível
como baseline e fallback até uma migração posterior, explicitamente aprovada.

## Contrato oficial confirmado

Contrato verificado em 2026-07-13 na documentação oficial Google Workspace:

- serviço REST v1: `https://gmail.googleapis.com`;
- discovery: `https://gmail.googleapis.com/$discovery/rest?version=v1`;
- revisão observada no Discovery Document em 2026-07-13: `20260706`;
- recursos: `users`, `messages`, `messages.attachments`, `threads`, `labels`,
  `drafts`, `history` e `settings`;
- scopes devem ser mínimos por operação: `gmail.readonly`/`gmail.metadata` para
  leitura, `gmail.labels` para labels, `gmail.send` para envio,
  `gmail.compose` para rascunhos e `gmail.modify` para alterações de mailbox;
- `https://mail.google.com/` fica reservado a exclusão permanente e não faz
  parte da Fase 1.

Fontes oficiais:

- https://developers.google.com/workspace/gmail/api/reference/rest
- https://developers.google.com/workspace/gmail/api/auth/scopes
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads
- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels

## Matriz legado → contrato oficial

`fonte_oficial` abaixo usa `REST` para a referência REST e `SCOPES` para a
página oficial de scopes listadas acima.

| operacao_sde | categoria | risco_read_write | endpoint_ou_recurso_oficial | status_decisao | justificativa | fonte_oficial | observacoes_para_ravi_dev |
|---|---|---|---|---|---|---|---|
| contas | setup | read-local | broker/conector, fora da Gmail API | ignorar | configuração local não é recurso Gmail | SCOPES | usar conexões Ravi, sem aliases compilados |
| auth-url, auth, health | setup | auth | OAuth 2.0, fora da entrega | aguardar | token real foi excluído da Fase 1 | SCOPES | falhar fechado via conector Ravi |
| perfil | leitura | read | `GET /gmail/v1/users/{userId}/profile` | adicionar | contrato oficial claro | REST | futuro comando nativo |
| inbox, buscar | leitura | read | `GET /gmail/v1/users/{userId}/messages` | migrar | coberto por `ravi gmail list --q` | REST | limite padrão 25, cursor explícito |
| ler | leitura | read-sensitive | `GET /gmail/v1/users/{userId}/messages/{id}` | migrar | coberto por `ravi gmail read` | REST | corpo pode conter dado sensível |
| enviar | entrega externa | high-write | `POST /gmail/v1/users/{userId}/messages/send` | migrar | contrato oficial e cliente nativo implementados | REST | `gmail:send` + confirmação; nenhuma chamada real nesta entrega |
| enviar-anexo | entrega externa | high-write | `POST /upload/gmail/v1/users/{userId}/messages/send` | adicionar | exige composição MIME/upload ainda ausente no CLI nativo | REST | `gmail:send`, limites de arquivo e step-up |
| responder, encaminhar | entrega externa | high-write | `messages.get` + `messages.send` | adicionar | são composições, não endpoints próprios | REST | exigir confirmação/step-up |
| thread, thread-detalhe | leitura | read-sensitive | `GET /gmail/v1/users/{userId}/threads/{id}` | adicionar | contrato oficial claro | REST | futuro comando nativo |
| threads-listar | leitura | read-sensitive | `GET /gmail/v1/users/{userId}/threads` | adicionar | contrato oficial claro | REST | paginação obrigatória |
| labels, label-detalhe | leitura | read | `users.labels.list/get` | adicionar | contrato oficial claro | REST | scope mínimo `gmail.labels` quando possível |
| criar-label | escrita | write | `POST /gmail/v1/users/{userId}/labels` | adicionar | escrita reversível | REST | permissão `gmail:write` futura |
| marcar-lido, marcar-nao-lido, aplicar-label, remover-label | escrita | write | `POST /gmail/v1/users/{userId}/messages/{id}/modify` | adicionar | modificação de labels | REST | permissão `gmail:write` futura |
| modificar-thread | escrita | write | `POST /gmail/v1/users/{userId}/threads/{id}/modify` | adicionar | modifica labels da thread | REST | permissão `gmail:write` futura |
| lixeira, restaurar-lixeira | destrutivo reversível | destructive | `messages.trash/untrash` | adicionar | mutação de mailbox, reversível por retenção do Gmail | REST | permissão `gmail:destructive` + confirmação |
| anexos | leitura | read-sensitive | `messages.get` | adicionar | metadados vêm no payload MIME | REST | não persistir por default |
| baixar-anexo | leitura + arquivo local | write-local | `GET .../messages/{messageId}/attachments/{id}` | estudar | leitura remota com side effect local | REST | path explícito e autorização de artifact |
| rascunhos | leitura | read-sensitive | `GET /gmail/v1/users/{userId}/drafts` | adicionar | contrato oficial claro | REST | paginação obrigatória |
| criar-rascunho | escrita | write | `POST /gmail/v1/users/{userId}/drafts` | adicionar | não envia mensagem | REST | permissão `gmail:write` futura |
| enviar-rascunho | entrega externa | destructive | `POST /gmail/v1/users/{userId}/drafts/send` | adicionar | envio irreversível | REST | `gmail:send` + step-up |
| deletar-rascunho | destrutivo permanente | destructive | `DELETE /gmail/v1/users/{userId}/drafts/{id}` | adicionar | deleção imediata e permanente | REST | confirmação forte; sem teste real |
| historico | leitura incremental | read-sensitive | `GET /gmail/v1/users/{userId}/history` | adicionar | contrato oficial claro | REST | cursor `startHistoryId` obrigatório |
| aliases | leitura | read-sensitive | `users.settings.sendAs.list` | adicionar | contrato oficial claro | REST | settings scope conforme método |
| filtros | leitura | read-sensitive | `users.settings.filters.list` | adicionar | contrato oficial claro | REST | não criar/alterar nesta fase |
| vacation | leitura | read-sensitive | `users.settings.getVacation` | adicionar | contrato oficial claro | REST | somente leitura |
| encaminhamentos | leitura | high-sensitive | `users.settings.forwardingAddresses.list` | adicionar | expõe destinos de encaminhamento | REST | permissão de settings distinta |
| delegados | leitura | high-sensitive | `users.settings.delegates.list` | estudar | requer Workspace/delegação administrativa | REST | não assumir disponibilidade em conta comum |
| config-conta | leitura | high-sensitive | `settings.getImap/getPop/getLanguage/getAutoForwarding` | adicionar | contratos oficiais claros | REST | separar auto-forwarding das configs básicas |

Não há operação financeira no domínio. A permissão `gmail:financial` não deve
existir sem uma operação financeira real.

## Invariants

- O app MUST usar `ravi gmail <operação> --native` e o cliente REST direto; MUST NOT
  executar `sde` nem depender do connector para suas operações registradas.
- O `ravi gmail` sem `--native` MUST continuar disponível como fallback do
  connector já publicado.
- A implementação MUST NOT ler arquivos legados de token. A validação da Fase
  1 MUST usar somente credencial e transporte falsos: sem token real,
  autenticação Google ou escrita remota.
- Leitura MUST usar `gmail:read`; entrega externa MUST usar `gmail:send` e
  permanecer classificada como mutação de alto risco no `@CommandAccess`.
- Futuras alterações de mailbox MUST usar `gmail:write`; lixeira/deleção MUST
  usar `gmail:destructive`; exclusão permanente não pode usar scope amplo por
  conveniência.
- O health check do app MUST validar estrutura sem exigir credencial.
- O SDE MUST permanecer intocado e operacional.

## Validation

- `bun test src/apps/gmail/app.test.ts src/apps/gmail/client.test.ts`
- `ravi apps check gmail --json`
- `bun run typecheck && bun run build && bun run sdk:check`
- `git diff -- /home/ravi/sde` deve permanecer vazio.

## Known Failure Modes

- Colisão entre app id `gmail` e grupo CLI estático ser tratada como recursão.
- Manifesto anunciar comando SDE ou operação ainda inexistente no Link.
- Health check exigir login/token e tornar descoberta impossível.
- Tratar envio como escrita comum, sem permissão e step-up próprios.

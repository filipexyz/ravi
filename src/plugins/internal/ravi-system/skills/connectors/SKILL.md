---
name: connectors
description: |
  Contas pessoais conectadas pelo Ravi Console (hoje Google: Gmail e Calendar), via `ravi connectors` e `ravi gmail`. Use quando precisar:
  - buscar, ler ou enviar email pela conta do dono
  - conectar, reconectar, listar ou desconectar uma conta
  - entender um bloqueio exit 3 `CONNECTOR_*` (grupo, outra pessoa, aprovação, ferramenta bloqueada)
  - pedir a aprovação do dono e rodar o mesmo comando de novo com `--approval <id>`
  gmail, email, e-mail, google, calendar, agenda, conector, conexão, aprovação
---

# Connectors

Uma conexão é uma conta de uma pessoa (o email dela), não de um projeto. As
credenciais ficam no serviço de conectores do Ravi; o CLI só pede a ação e
recebe o resultado. Precisa de `ravi login` (sem login: `AUTH_REQUIRED`).

## Quem pode usar

Toda conexão começa em "Only when I ask": serve só aos pedidos do próprio dono.

- Pode: o terminal do dono, o `ravi sessions send|ask` dele, o chat privado do
  dono com o agent depois do `ravi link`, e crons/heartbeat do dono que
  respondem em lugar nenhum ou só no chat privado dele.
- Não pode: outra pessoa (mesmo com tag de dono), grupo (nem o dono), outro
  agent repassando, triggers, observers, jobs.

O Ravi classifica o turno antes de qualquer chamada. Um turno recusado nunca
chega na conta e sai com exit `3`. Não tente contornar com outro `--connector`,
outra flag ou outro comando.

## Comandos

```bash
ravi connectors list --json                  # suas conexões, com o email
ravi connectors show <id> --json             # detalhes da conexão (email, status, escopos)
ravi connectors connect google               # imprime um link do Console (só o mesmo usuário abre)
ravi connectors connect google --read-only   # sem envio
ravi connectors connect google --reconnect <id>
ravi gmail list --q "is:unread" --max 10 --json
ravi gmail read <message-id> --json
ravi gmail send --to a@x.com --subject "Oi" --body "..."             # plano, exit 3
ravi gmail send --to a@x.com --subject "Oi" --body "..." --execute   # envia, ou pede aprovação
```

Sem `--connector`, o Gmail usa a conexão marcada como padrão no Console, senão
a Google ativa mais nova. A mesma conexão Google tem duas tools de agenda,
`gcal.event.list` ("Read your calendar") e `gcal.freebusy.query` ("See when
you're free or busy": horários ocupados entre duas datas, sem detalhes dos
eventos). Elas ainda não têm comando `ravi`, então o agent não usa a agenda
pelo CLI. As tools de cada conexão e a regra de cada uma ficam no Console, em
Connectors, na conexão, em Tools.

## Contrato do CLI

Rode com `--json` quando for decidir pelo resultado. Falha sai em
`{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
Nos bloqueios de conector, `error.message` diz o que fazer, `error.chatLine`
(e `chatLinePt`) é a frase para mandar, e `error.replyTo` diz onde:
`same_chat` (responda nesta conversa) ou `owner_privately` (só para o dono, no
privado, nunca num grupo).

| Código | O que aconteceu | O que fazer | Exit |
|---|---|---|---|
| `WRITE_REQUIRES_EXECUTE` | `gmail send` sem `--execute` | revise o plano e rode com `--execute` | 3 |
| `CONNECTOR_GROUP_BLOCKED` | pedido num grupo | diga no grupo "I'll send this to you privately." e peça ao dono para repetir no privado | 3 |
| `CONNECTOR_SPEAKER_NOT_OWNER` | quem pediu não é o dono | responda com o `chatLine` ("I can't use <dono>'s Gmail for your request.") | 3 |
| `CONNECTOR_APPROVAL_REQUIRED` | a ação precisa da aprovação do dono | veja Aprovações | 3 |
| `CONNECTOR_APPROVAL_PENDING` | o dono ainda não decidiu | espere; se ele não viu, mande o link de novo no privado | 3 |
| `CONNECTOR_APPROVAL_DENIED` | o dono recusou | não repita; diga que não fez | 3 |
| `CONNECTOR_APPROVAL_INVALID` | a aprovação expirou, já foi usada ou não bate com o comando | rode o mesmo comando sem `--approval` para pedir outra | 1 |
| `CONNECTOR_TOOL_BLOCKED` | o dono ou a organização bloqueou a tool | não repita; mande o `chatLine` ao dono no privado | 3 |
| `CONNECTOR_DISABLED_BY_ORG` | a organização desligou o Google | só dono ou admin da organização religa; avise o dono no privado | 3 |
| `CONNECTOR_PERMISSION_REQUIRED` | conexão só leitura, ou falta permissão | mande o `chatLine` ao dono no privado (Allow writing ou reconectar) | 1 |
| `CONNECTOR_REAUTH_REQUIRED` | a conexão expirou | mande o `chatLine` ao dono no privado, com o link de reconectar | 1 |
| `CONNECTOR_CONNECTION_REQUIRED` | não há conexão Google ativa | peça ao dono para conectar (`ravi connectors connect google` ou o Console) | 1 |

## Aprovações

Ler é liberado por padrão. Escrever (enviar email) pede a aprovação do dono
antes. Se o agent leu email ou agenda no mesmo pedido, enviar sempre pede
aprovação, mesmo com a tool em "Always allow".

1. Rode o comando com `--execute`. Se precisar de aprovação, sai exit `3`
   `CONNECTOR_APPROVAL_REQUIRED` com `approvalId`, `approvalLink`, `expiresAt`,
   `retryWith` (`--approval <id>`) e o `chatLine` ("Please approve this Gmail
   action: <link>"). Nada foi enviado.
2. Mande o `chatLine` ao dono no privado. Nunca num grupo.
3. Quando o dono disser que aprovou, rode o MESMO comando de novo, com os
   mesmos destinatários, assunto e texto, acrescentando `--approval <id>`:

   ```bash
   ravi gmail send --to a@x.com --subject "Oi" --body "..." --execute --approval <id>
   ```

   Mudar qualquer coisa no comando invalida a aprovação.
4. `CONNECTOR_APPROVAL_PENDING`: ele ainda não decidiu. `CONNECTOR_APPROVAL_DENIED`:
   não repita. `CONNECTOR_APPROVAL_INVALID`: rode sem `--approval` para pedir outra.

O pedido espera 15 minutos pela decisão; depois de aprovado, vale por 10
minutos e uma vez só. No terminal do próprio dono (sem `--json`), o comando
abre o link, espera a decisão e envia sozinho. `gmail list` e `gmail read`
também aceitam `--approval` quando o dono pôs uma tool de leitura em "Needs
approval".

O dono muda a regra de cada tool no Console, em Connectors, na conexão, em
Tools: "Always allow", "Needs approval" ou "Blocked". Não peça para mudar a
regra só para o envio passar.

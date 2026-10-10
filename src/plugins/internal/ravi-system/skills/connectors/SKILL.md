---
name: connectors
description: |
  Contas pessoais conectadas pelo Ravi Console (hoje Google: Gmail e Calendar), via `ravi connectors` e `ravi gmail`. Use quando precisar:
  - buscar, ler ou enviar email pela conta do dono
  - conectar, reconectar, listar ou desconectar uma conta
  - entender um bloqueio exit 3 `CONNECTOR_*` (grupo, outra pessoa, aprovação, ferramenta bloqueada)
  - pedir a aprovação do dono e rodar o mesmo comando de novo com `--approval <id>`
  - ver ou mudar de quem é a conta que um agent usa (`ravi connectors mode`: dono, quem pede, conta compartilhada)
  - pedir a quem está falando que libere o agent uma vez (`CONNECTOR_CONSENT_REQUIRED`) ou vincule o chat (`ravi link`)
  gmail, email, e-mail, google, calendar, agenda, conector, conexão, aprovação, consentimento, conta compartilhada
---

# Connectors

Uma conexão é uma conta de uma pessoa (o email dela), não de um projeto. As
credenciais ficam no serviço de conectores do Ravi; o CLI só pede a ação e
recebe o resultado. Precisa de `ravi login` (sem login: `AUTH_REQUIRED`).

## Quem pode usar

Todo agent começa no modo "Only when I ask" (`owner`): as contas do dono servem
só aos pedidos do próprio dono. O dono pode mudar isso por agent (veja Modo do
agent). Esta seção vale para o modo `owner`.

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
a Google ativa mais nova. `--connector` só nomeia conexões do dono: quando o
turno usa a conta de quem pede ou a compartilhada, o comando recusa
`--connector` (`PAYLOAD_INVALID`); rode sem ele. A mesma conexão Google tem duas tools de agenda,
`gcal.event.list` ("Read your calendar") e `gcal.freebusy.query` ("See when
you're free or busy": horários ocupados entre duas datas, sem detalhes dos
eventos). Elas ainda não têm comando `ravi`, então o agent não usa a agenda
pelo CLI. As tools de cada conexão e a regra de cada uma ficam no Console, em
Connectors, na conexão, em Tools.

## Modo do agent

Cada agent tem um modo para o Google. Só o dono muda, do terminal ou do chat
privado dele com o agent; um contato que pedir isso recebe exit `3`
`CONNECTOR_SPEAKER_NOT_OWNER` e nada muda. Se o dono pedir num grupo, também
nada muda: responda com o `chatLine` ("Ask me in our private chat and I'll
change it."). `ravi settings set` e `ravi settings delete` não mudam modo.

| Modo | Em palavras simples | Conta usada |
|---|---|---|
| `owner` ("Only when I ask", padrão) | só os pedidos do dono usam as contas dele | a do dono |
| `person-asking` ("The person asking") | cada pessoa usa o próprio Gmail, nunca o do dono, depois de liberar o agent uma vez | a de quem pede |
| `shared` ("Shared account") | uma conta da organização que um admin compartilhou com o agent no Console | a compartilhada |

```bash
ravi connectors mode main google                            # mostra o modo atual
ravi connectors mode main google person-asking              # plano, exit 3
ravi connectors mode main google person-asking --execute    # muda
ravi connectors mode main google shared --execute
ravi connectors mode main google owner                      # volta ao padrão na hora
```

Abrir para `person-asking` ou `shared` é dry-run (exit `3`) até `--execute`.
Voltar para `owner` aplica na hora. Em todo modo, os pedidos do próprio dono e
os crons/heartbeat dele continuam usando a conta dele. Para usar a
compartilhada num pedido do dono, acrescente `--shared` ao comando do Gmail,
só quando ele pedir no chat privado dele com você (ou num grupo que a conta
compartilhada cobre). No terminal, no `ravi sessions send`, numa rotina que não
responde em chat nenhum, ou sem o agent em `shared`, `--shared` sai com
`PAYLOAD_INVALID` (exit `2`).

- `person-asking`: vale só para contatos no chat privado com o agent, quando
  esse chat tem uma sessão só dele. Grupo continua bloqueado ("I can only use
  your Gmail in a direct chat with me. Ask me there."), e também um chat
  privado cuja sessão outras pessoas compartilham (DM scope `main`, uma rota
  que manda vários chats para a mesma sessão, um chat anexado): "I can't use
  your Gmail in this conversation." A pessoa precisa ter vinculado o chat
  (`ravi link`), ter um Gmail conectado no Console dela e liberar o agent uma
  vez pelo link de consentimento. Enviar sempre pede a aprovação dela, não a
  do dono.
- `shared`: contatos (no privado e nos grupos que o admin escolheu), e rotinas
  que respondem no chat de outra pessoa, usam a conta compartilhada. Ler começa
  bloqueado, menos livre/ocupado, até um admin liberar; enviar pede a
  aprovação de quem gerencia a conta.

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
| `CONNECTOR_CONNECTION_REQUIRED` | não há conexão Google ativa do dono | peça ao dono para conectar (`ravi connectors connect google` ou o Console) | 1 |

No modo `person-asking`, as falas vão para quem pediu, neste chat privado
(`replyTo: same_chat`), nunca para um grupo nem para outra pessoa:

| Código | O que aconteceu | O que fazer | Exit |
|---|---|---|---|
| `CONNECTOR_CONSENT_REQUIRED` | a pessoa ainda não liberou este agent | mande o `chatLine` ("To use your Gmail here, approve it once: <link>"; o link está em `consentLink`) e rode o mesmo comando de novo depois que ela aprovar | 3 |
| `CONNECTOR_NOT_LINKED` | o chat dela não está vinculado a uma conta Ravi | mande o `chatLine` (sem comando, pergunta se ela quer um link privado) e, se ela disser que sim, rode `ravi link` no turno dela | 3 |
| `CONNECTOR_CONNECTION_REQUIRED` | ela não tem Gmail conectado | mande o `chatLine` com o link do Console | 3 |
| `CONNECTOR_GROUP_BLOCKED` | pedido num grupo, ou num chat privado cuja sessão outras pessoas compartilham | responda com o `chatLine`; não repita | 3 |
| `CONNECTOR_APPROVAL_REQUIRED` | o envio precisa da aprovação dela | mande o link a ela neste chat; depois rode com `--approval <id>` | 3 |

No modo `shared`, `CONNECTOR_FORBIDDEN` (exit `3`) quer dizer que nenhuma conta
está compartilhada com o agent nesta conversa, e `CONNECTOR_CONNECTION_REQUIRED`
(exit `3`) que a conta compartilhada foi desconectada ou pausada: responda com
o `chatLine` e não repita. Uma aprovação vai para quem gerencia a conta, no Console; responda com
o `chatLine` e rode com `--approval <id>` depois que aprovarem.

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

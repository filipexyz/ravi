---
name: whatsapp-manager
description: |
  Gerencia funcionalidades do WhatsApp via Baileys. Use quando o usuário quiser:
  - Criar, gerenciar ou sair de grupos
  - Adicionar/remover membros de grupos
  - Gerar ou revogar links de convite
  - Renomear grupos ou mudar descrição
  - Alterar configurações de grupo (anúncio, locked)
  - Entrar em grupo via link de convite
  - Listar todos os grupos que o bot participa
  - Achar um grupo (inclusive um em que acabaram de te adicionar) e ver quem está nele
  - Mandar texto num grupo, marcando uma ou mais pessoas
  - Ligar um grupo que já existe a um agent
---

# WhatsApp Manager

> Verbos: CAPTAR · AGIR. Compõe com: routes, bases, triggers (reação).
> Solução com mais de uma peça? `ravi skills show solucoes` primeiro.

Funcionalidades do WhatsApp expostas via Omni/Baileys. Permite criar grupos, registrar rotas/sessões Ravi e operar grupos pelo CLI.

**Importante:** Todos os comandos precisam que o Omni esteja rodando com WhatsApp conectado.

**Criação de grupo:** `ravi whatsapp group create` usa a API HTTP pública do Omni (`POST /api/v2/instances/:id/groups`) e depois registra chat, rota, participantes e sessão no SQLite local do Ravi. Não use o tópico legado `ravi.whatsapp.group.create`.

**Operações de grupo:** `list`, `info` e `invite` são leituras; `list` e `info` tentam REST público do Omni e caem para o modelo local `chats` se o Omni falhar. As mutações usam contratos REST do Omni pelo cliente público. `demote` reduz autoridade e executa imediatamente; as demais mutações (`send`, `add`, `remove`, `promote`, `leave`, `join`, `revoke-invite`, `rename`, `description`, `settings`) são dry-run por default e exigem `--execute` (ver "Contrato Do CLI" abaixo). Não use nem sugira o bridge NATS legado `ravi.whatsapp.group.{op}`; quando um endpoint REST ainda não existir no Omni, o comando deve falhar explicitamente com erro `*_REST_UNAVAILABLE`.

**Novo fio de trabalho:** quando o usuário pedir para criar um grupo/agent para um assunto novo, use o fluxo transacional de criação. Não tente localizar o grupo com `ravi whatsapp group list`: listagem não registra chat/rota/sessão. Use `group list` apenas para inspeção.

**Gerenciamento de contas/instâncias:** use `ravi instances` (conectar, desconectar, status, policies).

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `GROUP_NOT_FOUND`, `CONTACT_NOT_FOUND`). O envelope traz `suggestions` com grupos/contatos reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido): corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi enviado/alterado no WhatsApp; o envelope traz `dryRun:true` e um plano sanitizado com alvo e efeito material, nunca o corpo integral da mensagem. Revise o plano e repita com `--execute`.

Onde o freio existe: `group send`, `group create`, `group add`, `group remove`, `group promote`, `group revoke-invite`, `group join`, `group leave`, `group rename`, `group description`, `group settings`, `dm send` e `dm ack`. Essas operações alteram estado que pessoas reais observam; revise o plano antes do efeito.

Sem freio: `group list`, `group info`, `group invite` e `dm read` são leituras; `group demote` é mutação imediata de redução de autoridade. `ravi whatsapp dm read <contact>` sempre consulta o histórico local sem enviar recibo. O antigo `--no-ack` ainda é aceito como no-op, mas não deve ser usado em chamadas novas. Para enviar o recibo de forma intencional, use `ravi whatsapp dm ack <contact> <messageId> --execute`.

Compact mode: `group list` e `dm read` aceitam `--fields a,b,c` (ex.: `--fields id,subject`) — use em varredura para não arrastar o objeto inteiro de cada item.

Checklist antes de responder sobre WhatsApp:

- Tratei exit 3 como freio (revisei o `plan`) e só repeti com `--execute` quando o efeito sobre pessoas reais era realmente desejado?
- Consultei `suggestions` do envelope (`GROUP_NOT_FOUND`/`CONTACT_NOT_FOUND`) antes de declarar que o grupo/contato não existe?
- Rodei o dry-run (exit 3) e conferi alvo e conta antes do `--execute`? Mensagem em grupo real não se desfaz.
- Confirmei QUEM é a pessoa antes de marcar (homônimos)? Em dúvida, pergunte nome completo ou final do número.
- Uma lista de membros não confirmada (`participantsComplete: false`) não prova que alguém "não está no grupo".

## Receitas do dia a dia

### Achar um grupo, inclusive um recém-adicionado

```bash
ravi whatsapp group list --account <conta> --limit 500 --fields id,subject,size --json
```

`group list` pagina em 50 e a primeira página **não** vem ordenada por atividade: com ~190 grupos, o que acabou de te adicionarem costuma ficar de fora. Use `--limit 500` e filtre por nome (`jq`), ou siga `pagination.nextCommand`.

Já ordenado por atividade, direto no Omni: `omni chats list --type group --sort activity --limit 5`. O `ID` dali é UUID do Omni; `omni chats get <uuid>` mostra o `externalId`, que é o JID `...@g.us` que o `ravi` aceita.

### Ver quem está no grupo

```bash
ravi whatsapp group info <jid> --account <conta> --json
```

- `participants` vem da lista ao vivo do WhatsApp (`participantsSource: "omni.group-members"`). Em grupo novo os ids são `<dígitos>@lid`; o nome só aparece para quem o Omni já viu falar no chat.
- `participantsComplete: false` e `participantsNote` dizem que a lista não foi confirmada pelo WhatsApp (a lista ao vivo falhou e sobrou só quem o Omni viu falar, que pode estar incompleta ou desatualizada, mesmo com a contagem batendo). Não conclua "fulano não está no grupo" por ela.
- Versões do CLI sem a lista ao vivo mostram só quem o Omni viu falar: `size` 7 com 1 participante é isso, não um grupo quase vazio.
- Direto no Omni: `omni instances group-members <instance-id> <jid>` (o `instanceId` sai do próprio `group info --json`).

### Achar a pessoa certa

```bash
ravi contacts find "Gustavo" --json
```

É `contacts find <consulta>`; não existe `contacts list --search`. Mais de um resultado: não adivinhe.

### Mandar texto no grupo, marcando alguém

`here` (o chat do turno) só vale em turno de WhatsApp; de outro canal passe o JID do grupo.

```bash
# 1. dry-run: sai com exit 3 e não envia nada
ravi whatsapp group send <jid> "oi, Gustavo! ..." --mention 5511987860700 --account <conta>
# 2. conferiu alvo e conta? repete com --execute
ravi whatsapp group send <jid> "oi, Gustavo! ..." --mention 5511987860700 --account <conta> --execute --json
```

- `--mention` aceita telefone (DDI + número, só dígitos), JID ou nome. Nome só funciona para quem o Omni conhece nesse chat. Pode repetir ou separar por vírgula.
- Não precisa escrever o `@` no texto: o comando põe `@<número>` na frente. Se você escrever (`@5511987860700 oi`), ele reconhece e não repete.
- O dry-run esconde o texto de propósito (só mostra tamanho e quantidade de menções): revise a mensagem antes de rodar com `--execute`. O resultado traz `messageId`, `mentionCount` e `resolvedMentions`.
- Marcou por telefone num grupo `@lid`? O envio usa o JID de telefone. Confirme no grupo, ou com a pessoa, que a marcação apareceu como menção e não como texto solto.
- Escreva a mensagem final, no tom de quem pediu, e envie uma vez. Não existe desfazer.

### Ligar um grupo que já existe a um agent

```bash
ravi instances routes list <instancia>                                   # quem atende o grupo hoje
ravi instances routes add <instancia> "group:<id-sem-@g.us>" <agent> --channel whatsapp
```

`group send` só manda a mensagem; não cria rota. Grupo do zero com agent é `group create ... --agent <id> --execute` (cria grupo, rota e sessão numa chamada).

### `ravi` ou `omni`?

- Texto, menção, membros, rota e conta: `ravi whatsapp ...`. É o que tem o freio de dry-run, a resolução de conta e de menção e o audit.
- Mídia (imagem, áudio, documento): `group send` não envia arquivo. Use `ravi media send <arquivo> --to <chat> --account <conta> --execute`, ou `omni send --media` se a regra do seu workspace pedir o `omni` direto.
- Leitura de baixo nível (UUID de chat, histórico, `group-members`): `omni chats ...` / `omni instances ...`.
- Não mande texto de grupo por `omni send`: perde o freio e a resolução de menção.

## Gerenciamento de Grupos

### Listar grupos
```bash
ravi whatsapp group list
```

### Ver info de um grupo
```bash
ravi whatsapp group info <groupId>
```

O `groupId` aceita:
- JID completo: `120363425628305127@g.us`
- Formato normalizado: `group:120363425628305127`

### Criar grupo
```bash
ravi whatsapp group create "Nome do Grupo" "5511999999999,5511888888888" --execute
```

Participantes separados por vírgula. Aceita números de telefone ou JIDs. Sem `--execute` é dry-run (exit 3): mostra o plano (participantes, admins, agent) e não cria nada.

**Com agent (recomendado):** cria o grupo real no WhatsApp, registra o chat local, cria a rota, cria/atacha a sessão e envia um inform inicial ao agent. Esse inform sobe um turno de verdade para o agent se apresentar; ele não fica adiado até a primeira mensagem humana:
```bash
ravi whatsapp group create "Vida - Health" "5511947879044" --agent health --execute
```

**Criar agent, criar grupo, adicionar participantes inferidos/explicitados e rotear em uma chamada:**
```bash
ravi whatsapp group create "Vida - Health" "5511888888888" \
  --agent health \
  --create-agent \
  --agent-cwd ~/ravi/health \
  --agent-provider codex \
  --agent-model gpt-5.5 \
  --execute
```

Ao criar agent inline com `--create-agent`, passe todas as configurações conhecidas no mesmo comando: `--agent-cwd`, `--agent-provider` e `--agent-model`. Use ajustes posteriores (`ravi agents set ...`) só para corrigir/migrar agent existente, não como fluxo normal de criação.

Quando o comando roda dentro de uma sessão Ravi, o criador pode ser inferido pelo actor do contexto e entra como participante inicial/admin. `--admin`/`--admins` também adiciona os números à lista inicial de participantes e o Ravi tenta promovê-los via contrato REST público de participantes do Omni logo após a criação. Quando a promoção passa, o payload retorna `adminPromotion.status = "promoted"` e o Ravi registra esses contatos como `admin`. Se o Omni falhar depois do grupo existir, o payload retorna `adminPromotion.status = "failed"` com o erro e os contatos ficam registrados sem confirmação de admin.

Se o usuário disser algo ambíguo como "criei um grupo para isso", "abre um grupo", "novo grupo/agent" ou "vamos separar esse assunto", trate como intenção de criar e rotear um novo workspace, salvo quando ele fornecer JID/link ou disser explicitamente que o grupo já existe.

Saída:
```
✓ Group created: Vida - Health
  ID:           120363405113391144@g.us
  Participants: 2
  Agent:        created health (/Users/luis/ravi/health)
  Chat:         registered
  Route:        health
  Session:      health-vida-health
```

### Sair de um grupo
```bash
ravi whatsapp group leave <groupId> --execute
```

## Membros

### Adicionar participantes
```bash
ravi whatsapp group add <groupId> "5511999999999,5511888888888" --execute
```

### Remover participantes
```bash
ravi whatsapp group remove <groupId> "5511999999999" --execute
```

### Promover a admin
```bash
ravi whatsapp group promote <groupId> "5511999999999" --execute
```
No fluxo `group create`, o Ravi usa o mesmo contrato REST de participantes do Omni para promover actor/admins inferidos ou explicitados. Fora da criação, `promote` chama esse mesmo contrato e deve falhar explicitamente se o endpoint não estiver disponível.

### Remover admin
```bash
ravi whatsapp group demote <groupId> "5511999999999"
```

## Convites

### Gerar link de convite
```bash
ravi whatsapp group invite <groupId>
```

Retorna o link `https://chat.whatsapp.com/...`

### Revogar link (gera novo)
```bash
ravi whatsapp group revoke-invite <groupId> --execute
```

### Entrar via link
```bash
ravi whatsapp group join "https://chat.whatsapp.com/ABC123" --execute
# ou só o código:
ravi whatsapp group join ABC123 --execute
```

## Configurações

### Renomear grupo
```bash
ravi whatsapp group rename <groupId> "Novo Nome" --execute
```

### Mudar descrição
```bash
ravi whatsapp group description <groupId> "Nova descrição do grupo" --execute
```

### Alterar settings
```bash
ravi whatsapp group settings <groupId> <setting> --execute
```

Settings disponíveis:
- `announcement` — só admins enviam mensagens
- `not_announcement` — todos enviam mensagens
- `locked` — só admins editam info do grupo
- `unlocked` — todos editam info do grupo

## Multi-account

Todos os comandos aceitam `--account <id>` pra especificar qual conta WhatsApp usar. Sem ele:

- turno que veio do WhatsApp (o canal do turno pode vir como `whatsapp-baileys`; é o mesmo canal): a conta do próprio turno;
- turno de outro canal (Slack, por exemplo) ou terminal, com **uma** conta WhatsApp habilitada: essa conta;
- turno de outro canal com **várias** contas WhatsApp: erro que lista as contas (`WhatsApp accounts: main, luis. Pass --account <id>`); passe `--account`;
- sem turno nenhum (terminal, cron, script) e várias contas: a primeira conta WhatsApp habilitada.

`--account` apontando para uma conta que não é WhatsApp (`ravi-slack`, por exemplo) é recusado com a lista das contas WhatsApp. Versões antigas usavam a conta do turno de qualquer canal e falhavam com `No omni instance mapped for account "ravi-slack"`: passe `--account <conta-whatsapp>`.

```bash
ravi whatsapp group list --account business
ravi whatsapp group create "Equipe" "5511999" --account business --execute
```

## Exemplos Práticos

### Criar grupo pra um agent
```bash
# Tudo num comando só:
ravi whatsapp group create "Vida - Finanças" "5511947879044" --agent financas --execute

# Cria o agent se ainda não existir; o actor da sessão entra como participante inicial:
ravi whatsapp group create "Vida - Finanças" "5511888888888" \
  --agent financas \
  --create-agent \
  --agent-provider codex \
  --agent-model gpt-5.5 \
  --execute

# Fora de uma sessão Ravi, ou para participantes que você quer incluir explicitamente:
ravi whatsapp group create "Vida - Finanças" "5511888888888" \
  --agent financas \
  --create-agent \
  --agent-provider codex \
  --agent-model gpt-5.5 \
  --admin 5511947879044 \
  --execute
```

Sem `--agent`, precisa rotear manualmente:
```bash
ravi whatsapp group create "Grupo Avulso" "5511999999999" --execute
ravi instances routes add main "group:<id>" meu-agent
```

### Gerenciar membros de equipe
```bash
# Ver quem tá no grupo
ravi whatsapp group info group:120363425628305127

# Adicionar novo membro
ravi whatsapp group add group:120363425628305127 "5511777777777" --execute

# Promover a admin
ravi whatsapp group promote group:120363425628305127 "5511777777777" --execute
```

### Gerar convite temporário
```bash
# Gerar link
ravi whatsapp group invite group:120363425628305127
# → https://chat.whatsapp.com/ABC123

# Depois de todos entrarem, revogar
ravi whatsapp group revoke-invite group:120363425628305127 --execute
```

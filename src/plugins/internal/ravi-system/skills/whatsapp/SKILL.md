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
---

# WhatsApp Manager

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

Sem freio: `group list`, `group info`, `group invite` e `dm read` são leituras; `group demote` é mutação imediata de redução de autoridade. `ravi whatsapp dm read <contact>` sempre consulta o histórico local sem enviar recibo. Para enviar o recibo de forma intencional, use `ravi whatsapp dm ack <contact> <messageId> --execute`.

Compact mode: `group list` e `dm read` aceitam `--fields a,b,c` (ex.: `--fields id,subject`) — use em varredura para não arrastar o objeto inteiro de cada item.

Checklist antes de responder sobre WhatsApp:

- Tratei exit 3 como freio (revisei o `plan`) e só repeti com `--execute` quando o efeito sobre pessoas reais era realmente desejado?
- Consultei `suggestions` do envelope (`GROUP_NOT_FOUND`/`CONTACT_NOT_FOUND`) antes de declarar que o grupo/contato não existe?

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

**Com agent (recomendado):** cria o grupo real no WhatsApp, registra o chat local, cria a rota, cria/atacha a sessão e envia um inform inicial ao agent:
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

Todos os comandos aceitam `--account <id>` pra especificar qual conta WhatsApp usar. Default: primeira instância.

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

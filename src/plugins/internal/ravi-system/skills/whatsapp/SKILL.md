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

**Operações de grupo:** `list` e `info` tentam REST público do Omni e caem para o modelo local `chats` se o Omni falhar. Todas as mutações (`add`, `remove`, `promote`, `demote`, `leave`, `join`, `invite`, `revoke-invite`, `rename`, `description`, `settings`) usam contratos REST do Omni pelo cliente público. Não use nem sugira o bridge NATS legado `ravi.whatsapp.group.{op}`; quando um endpoint REST ainda não existir no Omni, o comando deve falhar explicitamente com erro `*_REST_UNAVAILABLE`.

**Novo fio de trabalho:** quando o usuário pedir para criar um grupo/agent para um assunto novo, use o fluxo transacional de criação. Não tente localizar o grupo com `ravi whatsapp group list`: listagem não registra chat/rota/sessão. Use `group list` apenas para inspeção.

**Gerenciamento de contas/instâncias:** use `ravi instances` (conectar, desconectar, status, policies).

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
ravi whatsapp group create "Nome do Grupo" "5511999999999,5511888888888"
```

Participantes separados por vírgula. Aceita números de telefone ou JIDs.

**Com agent (recomendado):** cria o grupo real no WhatsApp, registra o chat local, cria a rota, cria/atacha a sessão e envia um inform inicial ao agent:
```bash
ravi whatsapp group create "Vida - Health" "5511947879044" --agent health
```

**Criar agent, criar grupo, adicionar participantes inferidos/explicitados e rotear em uma chamada:**
```bash
ravi whatsapp group create "Vida - Health" "5511888888888" \
  --agent health \
  --create-agent \
  --agent-cwd ~/ravi/health
```

Quando o comando roda dentro de uma sessão Ravi, o criador pode ser inferido pelo actor do contexto e entra como participante inicial. `--admin`/`--admins` também adiciona os números à lista inicial de participantes, mas **não promove admin automaticamente**: o contrato público atual do Omni ainda não expõe promoção de admin. Quando isso acontece, o payload retorna `adminPromotion.status = "skipped"` e o Ravi registra esses contatos como `member`, não `admin`.

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
ravi whatsapp group leave <groupId>
```

## Membros

### Adicionar participantes
```bash
ravi whatsapp group add <groupId> "5511999999999,5511888888888"
```

### Remover participantes
```bash
ravi whatsapp group remove <groupId> "5511999999999"
```

### Promover a admin
```bash
ravi whatsapp group promote <groupId> "5511999999999"
```
No fluxo `group create`, promoção automática de admin fica `skipped` até o Omni expor e validar o contrato público de promoção em criação. Fora da criação, `promote` chama o contrato REST de participantes do Omni e deve falhar explicitamente se esse endpoint não estiver disponível.

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
ravi whatsapp group revoke-invite <groupId>
```

### Entrar via link
```bash
ravi whatsapp group join "https://chat.whatsapp.com/ABC123"
# ou só o código:
ravi whatsapp group join ABC123
```

## Configurações

### Renomear grupo
```bash
ravi whatsapp group rename <groupId> "Novo Nome"
```

### Mudar descrição
```bash
ravi whatsapp group description <groupId> "Nova descrição do grupo"
```

### Alterar settings
```bash
ravi whatsapp group settings <groupId> <setting>
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
ravi whatsapp group create "Equipe" "5511999" --account business
```

## Exemplos Práticos

### Criar grupo pra um agent
```bash
# Tudo num comando só:
ravi whatsapp group create "Vida - Finanças" "5511947879044" --agent financas

# Cria o agent se ainda não existir; o actor da sessão entra como participante inicial:
ravi whatsapp group create "Vida - Finanças" "5511888888888" --agent financas --create-agent

# Fora de uma sessão Ravi, ou para participantes que você quer incluir explicitamente:
ravi whatsapp group create "Vida - Finanças" "5511888888888" --agent financas --admin 5511947879044
```

Sem `--agent`, precisa rotear manualmente:
```bash
ravi whatsapp group create "Grupo Avulso" "5511999999999"
ravi instances routes add main "group:<id>" meu-agent
```

### Gerenciar membros de equipe
```bash
# Ver quem tá no grupo
ravi whatsapp group info group:120363425628305127

# Adicionar novo membro
ravi whatsapp group add group:120363425628305127 "5511777777777"

# Promover a admin
ravi whatsapp group promote group:120363425628305127 "5511777777777"
```

### Gerar convite temporário
```bash
# Gerar link
ravi whatsapp group invite group:120363425628305127
# → https://chat.whatsapp.com/ABC123

# Depois de todos entrarem, revogar
ravi whatsapp group revoke-invite group:120363425628305127
```

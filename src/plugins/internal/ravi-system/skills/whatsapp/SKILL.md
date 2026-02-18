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

Funcionalidades do WhatsApp expostas via Baileys. Permite gerenciar grupos, membros, convites e configurações diretamente pelo CLI.

**Importante:** Todos os comandos precisam que o daemon esteja rodando com WhatsApp conectado. Os comandos se comunicam com o daemon via NATS (request/reply).

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

**Com agent (recomendado):** Auto-aprova o contato e cria a rota pro agent num comando só:
```bash
ravi whatsapp group create "Vida - Health" "5511947879044" --agent health
```

Saída:
```
✓ Group created: Vida - Health
  ID:           120363405113391144@g.us
  Participants: 2
  Contact:      approved
  Route:        health
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

Todos os comandos aceitam `--account <id>` pra especificar qual conta WhatsApp usar. Default: `default`.

```bash
ravi whatsapp group list --account business
ravi whatsapp group create "Equipe" "5511999" --account business
```

## Exemplos Práticos

### Criar grupo pra um agent
```bash
# Tudo num comando só:
ravi whatsapp group create "Vida - Finanças" "5511947879044" --agent financas
```

Sem `--agent`, o grupo é criado e aprovado automaticamente, mas sem rota — precisa rotear manualmente:
```bash
ravi whatsapp group create "Grupo Avulso" "5511999999999"
ravi routes add group:<id> meu-agent
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

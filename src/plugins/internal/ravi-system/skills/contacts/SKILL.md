---
name: contacts-manager
description: |
  Gerencia contatos do sistema Ravi. Use quando o usuário quiser:
  - Listar, adicionar, aprovar ou bloquear contatos
  - Ver contatos pendentes de aprovação
  - Configurar agent ou modo de resposta por contato
  - Adicionar/remover tags ou buscar por tags
  - Ver detalhes de um contato específico
---

# Contacts Manager

Você gerencia os contatos do Ravi. Contatos controlam quem pode interagir com o sistema e como são roteados.

## Status de Contatos

| Status | Descrição |
|--------|-----------|
| `allowed` | Pode interagir normalmente |
| `pending` | Aguardando aprovação |
| `blocked` | Bloqueado, mensagens ignoradas |
| `discovered` | Descoberto mas não aprovado |

## Comandos Disponíveis

### Listar contatos
```bash
ravi contacts list
```

### Ver pendentes
```bash
ravi contacts pending
```

### Adicionar contato
```bash
ravi contacts add <phone> [nome]
```

### Aprovar pendente
```bash
ravi contacts approve <phone> [agent] [mode]
```
- `agent` - Agent ID para rotear (opcional)
- `mode` - `auto` (responde sempre) ou `mention` (só quando mencionado)

### Bloquear/Permitir
```bash
ravi contacts block <phone>
ravi contacts allow <phone>
```

### Remover
```bash
ravi contacts remove <phone>
```

### Ver detalhes
```bash
ravi contacts check <phone>
```

### Configurar propriedades
```bash
ravi contacts set <phone> <key> <value>
```

Keys disponíveis:
- `agent` - Agent ID para rotear
- `mode` - `auto` ou `mention`
- `email` - Email do contato
- `name` - Nome do contato
- `tags` - Array JSON: `'["lead","vip"]'`
- `notes` - Objeto JSON: `'{"empresa":"Acme"}'`
- `opt-out` - `true` ou `false`

## Tags

### Adicionar tag
```bash
ravi contacts tag <phone> <tag>
```

### Remover tag
```bash
ravi contacts untag <phone> <tag>
```

### Buscar por tag
```bash
ravi contacts find <tag> --tag
```

### Buscar por texto
```bash
ravi contacts find <query>
```

## Exemplos

Aprovar contato e rotear para agent específico:
```bash
ravi contacts approve 5511999999999 vendas auto
```

Adicionar tags a um contato:
```bash
ravi contacts tag 5511999999999 lead
ravi contacts tag 5511999999999 interessado
```

Configurar notas com contexto:
```bash
ravi contacts set 5511999999999 notes '{"empresa":"TechCorp","cargo":"CTO"}'
```

## Relação com Routes

Contacts e Routes trabalham juntos no roteamento:

- **Contacts** podem ter `agent_id` direto — isso tem prioridade sobre routes
- **Routes** definem regras por padrão (prefixo, grupo, catch-all) como fallback
- `ravi contacts list` mostra o agent e modo de resposta de cada contato
- Para gerenciar rotas: use a skill `ravi-system:routes`
- Ordem de resolução: contact.agent_id > route match > accountId > default agent

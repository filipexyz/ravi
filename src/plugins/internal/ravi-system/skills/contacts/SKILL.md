---
name: contacts-manager
description: |
  Gerencia contatos do sistema Ravi. Use quando o usuário quiser:
  - Listar, adicionar, aprovar ou bloquear contatos
  - Ver contatos pendentes de aprovação
  - Garantir captura automática de contatos a partir de DMs/chats
  - Rodar backfill de contatos canônicos a partir do ledger de chats
  - Configurar agent ou modo de resposta por contato
  - Adicionar/remover tags ou buscar por tags
  - Ver detalhes de um contato específico
---

# Contacts Manager

Você gerencia os contatos canônicos do Ravi. Contato é pessoa ou organização; grupo, chat, thread e sessão não são contato.

Use esta skill para operar identidade, policy e intake de contatos. Não use contacts para guardar análise IA de atendimento: análises, facts, oportunidades e tarefas pertencem ao CRM/observers.

## Modelo Atual

- `contacts`: ficha canônica de pessoa/org.
- `contact_policies`: status operacional e roteamento do contato.
- `platform_identities`: vínculo canal/instância/id técnico para contato ou agent.
- `contact_events`: timeline auditável e append-only.
- `chats`, `chat_messages`, `chat_participants`: ledger bruto de conversas no router DB.
- `chat_reading_lists`: filas de leitura independentes para observers/agentes.

Fluxo P0:

```text
DM chega -> chat/message ledger salva tudo -> contact intake cria/linka contato -> platform identity vincula -> mensagens/participantes apontam para o contato
```

CRM estrito começa depois disso. Observers leem listas de leitura e escrevem facts/oportunidades/tarefas no CRM.

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

### Backfill de contatos a partir de chats
Use para retroativamente transformar DMs já capturadas em contatos canônicos e vincular mensagens/participantes ao contato.

Sempre rode dry-run antes de aplicar:

```bash
ravi contacts backfill --instance <instance-name-or-id> --mode discovered --dry-run --json
ravi contacts backfill --instance <instance-name-or-id> --mode discovered --create-list crm-analysis-pending --apply --json
```

Opções principais:
- `--instance <name-or-id>` filtra uma instância/conta. Aceita nome lógico (`main`, `sde`) ou UUID técnico do Omni; o backfill resolve ambos e consulta o ledger nos dois formatos.
- `--channel <channel>` filtra canal, normalmente `whatsapp`.
- `--mode discovered|pending` define status para contatos novos. Use o mesmo modo de `contactIntakeMode` da instância.
- `--limit <n>` limita candidatos.
- `--create-list <name>` adiciona chats vinculados a uma reading list para análise posterior.
- `--list-owner <type:id>` escopa a lista, default `agent:ravi-crm`.
- Sem `--apply`, o comando é apenas preview.

Regras de segurança do backfill:
- Não cria contato para grupo/chat/thread.
- Não toma posse de identidade já pertencente a agent.
- Não rebaixa `allowed`, `blocked` ou opt-out.
- Não aprova conversa nem cria rota de atendimento; só cria/linka identidade e contato.
- Preserva histórico bruto; só adiciona links canônicos e eventos auditáveis.

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

## Relação com Instâncias

Auto intake é configuração por instância:

```bash
ravi instances show <instance> --json
ravi instances set <instance> contactIntakeMode discovered
```

Modos:
- `off`: não cria/linka contato automaticamente.
- `discovered`: cria/linka contato sem colocar como pendente de ação operacional.
- `pending`: cria/linka contato como pendente.

Para a base já existente, use `ravi contacts backfill`. Para novas mensagens, configure `contactIntakeMode`.

## Relação com Observers e CRM

Contacts deve parar na identidade/policy/vínculo com chat. Depois:

- Reading lists organizam quais chats serão lidos.
- Observers analisam deltas de mensagens.
- CRM recebe conclusões: facts, opportunities, activities, tasks e next actions.

Não adicione campos de análise IA em contacts se a informação puder ser produzida por observer e gravada como CRM fact/event.

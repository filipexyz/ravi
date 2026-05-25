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

## Inspeção Operacional

Quando precisar diagnosticar o estado do CRM, NUNCA olhe um plano isolado. Sempre rode esta sequência em paralelo para ter a foto completa:

```bash
# Plano 1: identidade/policy
ravi contacts list --limit 5 --json
ravi contacts pending --json

# Plano 2: ledger bruto de conversas (independente de contato canônico)
ravi chats list --limit 5 --json
ravi chats lists list --json

# Plano 3: configuração de captura por canal
ravi instances list --json

# Plano 4: classificação automática
ravi tag-rules list --json

# Plano 5: ação automatizada
ravi observers rules list --json
```

⚠️ **Por que cobrir ledger e contatos juntos**: é possível ter centenas de chats no `ravi.db` ledger e poucos contatos canônicos em `chat.db`. Essa divergência indica que intake estava `off`, ou que dados antigos precisam de backfill, ou que os senders eram grupos (não viram contato). Sem comparar os dois planos, o diagnóstico fica incompleto.

⚠️ **Reading lists zeradas + chats ativos** = pipeline desligado. Sempre reporte os dois números.

Apresente o resultado consolidado nesta estrutura:

```
📋 Identidade
   🔹 X contatos canônicos (Y allowed / Z discovered / W pending / K blocked)
   🔹 N pendentes de aprovação

📋 Conversas no ledger
   🔹 C chats (D DMs / G grupos)
   🔹 M mensagens trocadas

📋 Configuração por instância
   🔹 Lista de instâncias com intake mode + default tags

📋 Automação
   🔹 R tag rules carregadas
   🔹 O observer rules ativas
   🔹 L reading lists (com membros / vazias)
```

Se houver divergência entre planos (ex: 300 chats, 5 contatos), explicite ANTES de sugerir próximo passo.

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

## Relação com Reading Lists Dinâmicas

Tags de contato são a entrada primária do motor de membership dinâmico. Listas com `mode: dynamic` ou `mode: hybrid` têm um `selector` que pode filtrar por `has-tag`, `not-has-tag`, `has-any-tag`, `has-all-tags` no scope `contact`.

Quando uma tag é adicionada ou removida (via `ravi contacts tag/untag` ou via tag rule), o motor:
1. Detecta quais listas dinâmicas usam essa tag como condição.
2. Reavalia o contato e todos os chats associados.
3. Adiciona ou remove automaticamente (soft-delete, cursor preservado).

```bash
# Ver listas afetadas por um contato
ravi chats lists explain <lista> --target contact:<id>

# Forçar reavaliação de uma lista
ravi chats lists tick --list <nome-ou-id> --apply

# Criar lista que agrupa chats de contatos com tag "lifecycle:qualified"
ravi chats lists create "Leads Qualificados" --mode dynamic \
  --selector '{"scope":"contact","match":"all","conditions":[{"kind":"has-tag","tag":"lifecycle:qualified"}]}'
```

Spec completa: `.ravi/specs/channels/chats/reading-lists/DYNAMIC-MEMBERSHIP.md`

## Relação com Observers e CRM

Contacts deve parar na identidade/policy/vínculo com chat. Depois:

- Reading lists organizam quais chats serão lidos (estáticas: seleção manual; dinâmicas: seleção por tags/condições).
- Observers analisam deltas de mensagens.
- CRM recebe conclusões: facts, opportunities, activities, tasks e next actions.

Não adicione campos de análise IA em contacts se a informação puder ser produzida por observer e gravada como CRM fact/event.

## Auto Tags por Instância

Cada instância pode declarar tags default que vão automaticamente para qualquer contato canônico criado pelo intake (runtime ou backfill).

Regras:
- Aplica somente quando o contato é criado pela primeira vez (`createdContact=true`). Contato já existente não recebe tag default.
- Tags entram via `attachCanonicalContactTag` e ficam refletidas em `contact_policies.tags_json`.
- Cada aplicação emite um evento `profile.tag_added` em `contact_events` com `reason: instance_default_contact_tags`, preservando proveniência por instância.
- Backfill respeita a mesma regra: só aplica em chats que viram `create_contact`; `link_existing` e `already_linked` não tocam tags.

Configurar:

```bash
ravi instances set <instance> defaultContactTags new-contact
ravi instances set <instance> defaultContactTags '["new-contact","needs-triage"]'
ravi instances set <instance> defaultContactTags -
```

Aceita CSV ou JSON array. `-` ou `null` limpa.

Inspecionar:

```bash
ravi instances show <instance>
# ou via JSON:
ravi instances show <instance> --json | jq .instance.defaultContactTags
```

## Playbook: Tag → Observer por Contato

Fluxo end-to-end para uma instância tratar cada novo contato como um lead vivo, com observers trocando de tag para coordenar etapas.

### 1. Configurar instância

```bash
ravi instances set <instance> contactIntakeMode discovered
ravi instances set <instance> defaultContactTags new-contact
```

Resultado: todo DM novo cria contato canônico e ganha a tag `new-contact`. Contatos antigos não recebem tag retroativa — use `ravi contacts tag <id> new-contact` se quiser equiparar.

### 2. (Opcional) Definir tag formalmente

Tags slugificam automaticamente, mas definir traz label e descrição auditável:

```bash
ravi tags define new-contact --label "New Contact" --description "Contato recém-capturado pelo intake"
```

### 3. Criar observer rule por tag de contato

```bash
ravi observers rules set new-contact-watch <observer-agent> \
  --scope tag \
  --tag new-contact \
  --tag-target contact \
  --observer-role new-contact-watch \
  --observer-mode summarize \
  --profile default
```

A sessão fonte é resolvida automaticamente via `session_participants`: se a sessão tem participante contato com a tag, o rule dispara e cria binding observer.

### 4. Observer trabalha o lead e troca a tag para encadear

Dentro do prompt do observer, ele tem permissão pra ler conversa e propor próximos passos. Para entregar o lead à próxima etapa, troca a tag do contato:

```bash
ravi contacts untag <contactId> new-contact
ravi contacts tag <contactId> lead-qualified
```

Outro observer rule pode estar bound a `--tag lead-qualified --tag-target contact`. Na próxima evaluation (quando uma nova mensagem chega ou outra rebind ocorre), o novo observer entra em ação.

### 5. Auditoria e debugging

```bash
ravi observers rules explain --session <session>
ravi contacts events <phone>
ravi observers list --source-session <session>
```

`explain` mostra `source.contactIds` e quais tags de contato estão sendo coletadas no descriptor.

### Limitações conhecidas

- Bindings antigos não são removidos automaticamente quando a tag muda. O observer antigo continua bound até intervenção manual (`ravi observers unbind` ou expiração natural).
- Para sessões DM-per-peer (1 contato por sessão), o fluxo é determinístico. Em sessões `main` ou de grupo, vários contatos podem coexistir e cada um carrega suas tags.
- `defaultContactTags` aplica só na criação. Se você precisa retaguear contatos existentes para inseri-los no fluxo, faça via `ravi contacts tag <id> <tag>` em lote.

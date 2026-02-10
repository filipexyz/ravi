# Test Cases — v0.6.x

Cenarios de teste pra validar as features implementadas. Rodar manualmente com daemon ativo.

---

## 1. WhatsApp Group Management (`ravi whatsapp group`)

### 1.1 List groups
```bash
ravi whatsapp group list
```
- [ ] Lista todos os grupos do bot
- [ ] Exclui communities da lista principal
- [ ] Mostra ID, nome e tamanho
- [ ] Mostra total de grupos

### 1.2 Group info
```bash
ravi whatsapp group info <groupId>
```
- [ ] Mostra metadata completo (subject, description, owner, creation)
- [ ] Mostra lista de participantes com role (admin/member)
- [ ] Aceita formato `group:123456` e `123456@g.us`
- [ ] Erro claro se grupo nao existe

### 1.3 Create group
```bash
ravi whatsapp group create "Teste Ravi" 5511999999999,5511888888888
```
- [ ] Cria grupo com nome e participantes
- [ ] Retorna ID do grupo criado
- [ ] Participantes recebem convite
- [ ] Erro se numero invalido

### 1.4 Add/remove members
```bash
ravi whatsapp group add <groupId> 5511999999999
ravi whatsapp group remove <groupId> 5511999999999
```
- [ ] Adiciona participante ao grupo
- [ ] Remove participante do grupo
- [ ] Mostra status por participante (sucesso/falha)
- [ ] Erro se bot nao e admin

### 1.5 Promote/demote
```bash
ravi whatsapp group promote <groupId> 5511999999999
ravi whatsapp group demote <groupId> 5511999999999
```
- [ ] Promove participante a admin
- [ ] Remove admin de participante
- [ ] Erro se bot nao e admin

### 1.6 Invite link
```bash
ravi whatsapp group invite <groupId>
ravi whatsapp group revoke-invite <groupId>
```
- [ ] Gera link de convite (https://chat.whatsapp.com/...)
- [ ] Revoga link antigo e gera novo
- [ ] Erro se bot nao e admin

### 1.7 Join via link
```bash
ravi whatsapp group join "https://chat.whatsapp.com/ABC123"
ravi whatsapp group join "ABC123"
```
- [ ] Aceita URL completa e codigo isolado
- [ ] Retorna ID do grupo ao entrar
- [ ] Erro se link invalido/expirado

### 1.8 Leave group
```bash
ravi whatsapp group leave <groupId>
```
- [ ] Sai do grupo
- [ ] Confirmacao de saida

### 1.9 Rename group
```bash
ravi whatsapp group rename <groupId> "Novo Nome"
```
- [ ] Renomeia o grupo
- [ ] Erro se bot nao e admin (em grupos restritos)

### 1.10 Description
```bash
ravi whatsapp group description <groupId> "Nova descricao"
```
- [ ] Atualiza descricao do grupo
- [ ] Erro se bot nao e admin (em grupos restritos)

### 1.11 Settings
```bash
ravi whatsapp group settings <groupId> announcement
ravi whatsapp group settings <groupId> not_announcement
ravi whatsapp group settings <groupId> locked
ravi whatsapp group settings <groupId> unlocked
```
- [ ] `announcement` — apenas admins enviam mensagem
- [ ] `not_announcement` — todos enviam
- [ ] `locked` — apenas admins editam info
- [ ] `unlocked` — todos editam info
- [ ] Erro se bot nao e admin

### 1.12 Multi-account
```bash
ravi whatsapp group list --account secondary
```
- [ ] Todas operacoes aceitam `--account <id>`
- [ ] Default e "default"
- [ ] Erro claro se account nao existe/nao conectada

### 1.13 Request/Reply timeout
- [ ] Operacao retorna erro apos 15s se daemon nao responde
- [ ] Stream de notif e limpo apos timeout (sem leak)
- [ ] Stream de notif e limpo apos sucesso (sem leak)

### 1.14 Agent como tool
- [ ] Agent consegue chamar `whatsapp_group_list` como tool
- [ ] Agent consegue chamar `whatsapp_group_create` como tool
- [ ] Resultado retorna formatado pro agent

---

## 2. Session Management (`ravi sessions`)

### 2.1 List sessions
```bash
ravi sessions list
ravi sessions list --agent main
```
- [ ] Lista todas as sessoes com tokens, modelo, nome
- [ ] Filtro por agent funciona
- [ ] Ordenado por updated_at desc
- [ ] Mostra total

### 2.2 Session info
```bash
ravi sessions info "agent:main:main"
```
- [ ] Mostra todos os campos: nome, agent, model, thinking, SDK ID
- [ ] Mostra tokens (input, output, total, context)
- [ ] Mostra routing (channel, chatId, account)
- [ ] Mostra queue mode, compactions, timestamps
- [ ] Erro se sessao nao existe

### 2.3 Rename session
```bash
ravi sessions rename "agent:main:main" "Principal"
```
- [ ] Define display_name na sessao
- [ ] `ravi sessions list` mostra nome novo
- [ ] Erro se sessao nao existe

### 2.4 Set model override
```bash
ravi sessions set-model "agent:main:main" opus
ravi sessions set-model "agent:main:main" sonnet
ravi sessions set-model "agent:main:main" haiku
ravi sessions set-model "agent:main:main" clear
```
- [ ] Define model_override no DB
- [ ] `clear` remove o override (volta pro default do agent)
- [ ] `ravi sessions info` mostra o override
- [ ] **Efeito real**: apos reset+nova mensagem, sessao usa o modelo definido
- [ ] Cascata: session.modelOverride > agent.model > config.model

### 2.5 Set thinking level
```bash
ravi sessions set-thinking "agent:main:main" verbose
ravi sessions set-thinking "agent:main:main" normal
ravi sessions set-thinking "agent:main:main" off
ravi sessions set-thinking "agent:main:main" clear
```
- [ ] Define thinking_level no DB
- [ ] `clear` remove o override
- [ ] Rejeita valores invalidos (ex: "super")
- [ ] `ravi sessions info` mostra o nivel

### 2.6 Reset session
```bash
ravi sessions reset "agent:main:main"
```
- [ ] Deleta sessao do DB
- [ ] Proxima mensagem cria sessao nova (sdk_session_id novo)
- [ ] Conversa anterior e perdida (fresh start)
- [ ] Erro se sessao nao existe

### 2.7 Reset all sessions
```bash
ravi sessions reset-all main
```
- [ ] Deleta todas sessoes do agent
- [ ] Mostra quantidade deletada
- [ ] Mensagem se nao tem sessoes

### 2.8 Model override end-to-end
```
1. ravi sessions set-model "agent:main:main" haiku
2. ravi sessions reset "agent:main:main"
3. Enviar mensagem pro agent via WhatsApp
4. Verificar nos logs que o SDK usou modelo haiku
5. ravi sessions set-model "agent:main:main" clear
6. ravi sessions reset "agent:main:main"
7. Enviar outra mensagem
8. Verificar que voltou ao modelo default do agent
```
- [ ] Modelo muda efetivamente na sessao do SDK
- [ ] Logs confirmam modelo correto

---

## 3. Nested CLI (`ravi whatsapp group`)

### 3.1 Help output
```bash
ravi whatsapp --help
ravi whatsapp group --help
```
- [ ] `ravi whatsapp` mostra subcomando `group`
- [ ] `ravi whatsapp group` mostra todos os 14 commands
- [ ] Help de cada comando mostra args e options

### 3.2 Tool names
- [ ] Tools exportados com underscore: `whatsapp_group_list`, `whatsapp_group_create`, etc.
- [ ] Agent vê tools com nome correto
- [ ] Nao quebra tools existentes (sem `.` nos nomes)

---

## 4. Request/Reply Infrastructure

### 4.1 Happy path
- [ ] CLI emite request, daemon recebe, executa, emite reply
- [ ] CLI recebe reply e exibe resultado
- [ ] Round-trip < 5s pra operacoes simples (list, info)

### 4.2 Timeout
- [ ] Se daemon nao responde em 15s, CLI mostra erro de timeout
- [ ] Processo CLI termina limpo (nao fica pendurado)

### 4.3 Error propagation
- [ ] Se Baileys joga erro, chega formatado no CLI
- [ ] Ex: "WhatsApp account X not connected", "Invalid ID: Y"

### 4.4 Stream cleanup
- [ ] `stream.return()` chamado apos sucesso
- [ ] `stream.return()` chamado apos timeout
- [ ] `stream.return()` chamado apos erro
- [ ] Nao acumula subscriptions em uso repetido

---

## 5. Gateway Integration

### 5.1 Topic matching
- [ ] `ravi.whatsapp.group.*` matcha todos os ops (create, list, info, etc.)
- [ ] `ravi.whatsapp.group.revoke-invite` matcha (hifen nao quebra wildcard)
- [ ] Outros topics nao sao capturados

### 5.2 Error handling
- [ ] Erro em operacao nao crasha o gateway
- [ ] Erro e emitido no replyTopic
- [ ] Log de erro no gateway com op e mensagem

---

## 6. Compaction (validacao contínua)

- [ ] PreCompact hook funciona (confirmado 2026-02-10)
- [ ] Memoria extraida pro MEMORY.md
- [ ] Mensagens durante compaction sao enfileiradas (nao perdidas)
- [ ] Anuncio de compaction aparece no chat (se habilitado)

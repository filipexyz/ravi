---
name: instances-manager
description: |
  Gerencia instâncias de canais do Ravi. Use quando o usuário quiser:
  - Criar, listar ou configurar instâncias (WhatsApp, Telegram, Discord, etc)
  - Conectar, desconectar ou deslogar contas WhatsApp (Baileys no runner `ravi channels`)
  - Migrar uma instância WhatsApp que estava no Omni para o runner `ravi channels`
  - Definir policies de DM e grupo por instância
  - Configurar contact intake automático por instância
  - Gerenciar rotas de uma instância específica
  - Aprovar ou rejeitar pendências de acesso
---

# Instances Manager

Instâncias são a entidade central de configuração do Ravi. Cada instância representa uma conta conectada (WhatsApp, Telegram, Discord, etc) com seu próprio agent, policies e rotas.

Transportes: WhatsApp roda sempre no runner `ravi channels` (Baileys, processo PM2 `ravi-channels`). Telegram e Discord passam pela ponte legada Omni, que é opcional. WhatsApp nunca passa pelo Omni; instâncias `twilio-whatsapp` e `gupshup` não são suportadas (`connect`, `create`, `disconnect` e `status` falham com `USAGE_ERROR`).

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (ex.: `INSTANCE_NOT_FOUND`, `ROUTE_NOT_FOUND`). O envelope traz `suggestions` com instâncias/rotas reais parecidas — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido). O envelope traz `acceptedFlags`: corrija a chamada, não insista na mesma sintaxe.
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com exatamente o que seria feito. Revise o plano e repita com `--execute`.

Onde o freio existe hoje: `instances logout` e `instances pending reject` são dry-run por default e exigem `--execute`. As demais escritas gravam na hora, sem dry-run: `create`, `set`, `enable`, `disable`, `restore`, `delete`, `disconnect`, `connect` (interativo com QR — humano no loop), `routes add`, `routes set`, `routes remove`, `routes restore`, `pending approve`. Nessas o freio é você: confira o alvo antes de rodar. Atenção: `delete` numa instância WhatsApp também desloga, apaga as credenciais e desliga o canal; `restore` traz a config de volta (e religa o canal se a instância está habilitada), mas é preciso parear de novo com `connect`.

Compact mode: `instances list` e `routes list` aceitam `--fields a,b,c` (ex.: `--fields name,channel,agent`) — use em varredura para não arrastar o objeto inteiro de cada instância/rota.

Help por operação: `ravi instances <op> --help` (idem nos grupos `routes` e `pending`) é enxuto; prefira-o ao help do domínio inteiro.

Checklist antes de responder sobre instâncias:

- Tratei exit 3 como freio (revisei o `plan`) e não como falha?
- Consultei `suggestions` do envelope antes de declarar not-found?

## Inspeção Cruzada

Instância isolada não conta a história toda. Ao diagnosticar o estado, combine instância com o que ela produz:

```bash
ravi instances list --json                    # canais conectados, intake mode, default tags
ravi instances show <name> --json             # detalhes + rotas + status ao vivo + transport (whatsapp|omni)
ravi contacts list --json                     # quantos contatos cada instância gerou
ravi chats list --json                        # quantos chats por instância
```

⚠️ **Instância sem `contactIntakeMode=discovered|pending`** = mensagens chegam mas não viram contato canônico. Cheque sempre.

⚠️ **Instância conectada mas sem agent** = mensagens caem na fila default ou em pending. Pode ser intencional (catch-all manual) ou esquecimento.

⚠️ **`defaultContactTags` vazia** + intake ligado = contatos criam sem etiqueta inicial. Sem etiqueta inicial, regras de classificação não têm gatilho.

## Comandos Principais

### Listar instâncias
```bash
ravi instances list
```

### Ver detalhes
```bash
ravi instances show <name>
```

### Criar instância
```bash
ravi instances create <name>
ravi instances create vendas --agent vendas-agent --channel whatsapp
```

### Configurar propriedades
```bash
ravi instances set <name> <key> <value>
```

Keys disponíveis:
- `agent` - Agent ID padrão desta instância
- `dmPolicy` - Política para DMs: `open` | `pairing` | `closed`
- `groupPolicy` - Política para grupos: `open` | `allowlist` | `closed`
- `dmScope` - Escopo de sessões DM: `main` | `per-peer` | `per-channel-peer` | `per-account-channel-peer`
- `contactIntakeMode` - Criação/link automático de contatos em DMs: `off` | `discovered` | `pending`
- `instanceId` - UUID de transporte da instância (auto-preenchido no connect; uma instância vinda do Omni mantém o mesmo UUID, nunca troque numa migração)
- `channel` - Canal: `whatsapp` | `telegram` | `discord` | etc

### Remover instância
```bash
ravi instances delete <name>            # soft-delete imediato, recuperável com restore (WhatsApp: desloga, apaga as credenciais e desliga o canal)
ravi instances restore <name>           # restaura; WhatsApp: religa o canal se a instância está habilitada (pareie de novo com connect)
```

## Conexão de Canal

### Conectar WhatsApp
```bash
ravi instances connect <name>
ravi instances connect vendas --agent vendas-agent
```

`connect` de WhatsApp sempre usa o runner `ravi channels`. Não existe flag `--transport` nem setting `whatsapp.transport`. Para Telegram/Discord, `ravi instances connect <name> --channel telegram` usa a ponte legada Omni.

### Ver status
```bash
ravi instances status <name>
```

Com `--json`, `status`, `show`, `list` e `disconnect` trazem `transport` (`whatsapp`, `omni` para a ponte legada, ou `null` para `twilio-whatsapp`/`gupshup`). Instância WhatsApp consulta o runner: `live` traz `state` (`connected`, `connecting`, `qr`, `disconnected`, `logged_out`, `error`). Em `list`, runner fora do ar aparece como `disconnected` sem falhar; em `status`, o comando falha (rode `ravi channels start`).

### Desconectar, deslogar, desabilitar
```bash
ravi instances disconnect <name>             # fecha o socket, mantém as credenciais
ravi instances logout <name>                 # dry-run (exit 3): mostra o plano
ravi instances logout <name> --execute       # apaga as credenciais; desvincula o aparelho só se estiver conectado (senão: WhatsApp > Aparelhos conectados)
ravi instances disable <name>                # desliga a instância e o canal WhatsApp dela
```

- `disconnect` persiste entre reinícios do runner (saúde `disconnected` / `manual_disconnect`) até o próximo `connect`, que reconecta sem QR.
- `logout` só vale para WhatsApp. Depois dele, só um QR novo pareia a conta. Se o runner não responder, as credenciais são apagadas localmente; remova o aparelho no celular (WhatsApp > Aparelhos conectados).
- `enable`/`disable` também ligam/desligam o canal WhatsApp da instância; `disable` mantém as credenciais.

## WhatsApp No Runner `ravi channels`

O WhatsApp roda o Baileys dentro do runner `ravi channels` (processo PM2 `ravi-channels`). O daemon recebe os eventos pelo stream `CHANNEL_INBOUND` e processa no mesmo pipeline de sempre: sessões, chats, contatos e rotas.

Pré-requisitos:

- `ravi daemon start` rodando (ele repassa os QR codes para o CLI);
- `ravi channels start` rodando (o daemon não sobe o runner sozinho). Depois de atualizar o Ravi, reinicie o daemon e depois o runner (`ravi daemon restart -m "whatsapp runner upgrade" && ravi channels restart`; o `-m` com o motivo é obrigatório): o runner recusa um bundle diferente do daemon.

O que `ravi instances connect <name>` faz:

1. cria a instância com UUID novo, ou mantém o UUID que ela já tem (ex.: vindo do Omni);
2. cria o canal `<name>` com provider `whatsapp` (`ravi channels show <name>`); o vínculo canal↔instância é pelo nome (ou por `defaults.instance` quando o nome do canal precisou ser sanitizado);
3. avisa o runner (`ravi.config.changed`) e espera até 15s ele subir o canal;
4. imprime QR codes até o celular conectar (até 120s); com `--json`, retorna no primeiro QR.

Erros comuns:

- `WHATSAPP_RUNNER_UNAVAILABLE`: o runner não respondeu. Rode `ravi channels start` (ou `ravi channels restart`) e repita o mesmo comando; instância e canal já ficaram criados.
- `INSTANCE_CONNECT_TIMEOUT`: nenhum QR/conexão chegou. Confira `ravi daemon status` e `ravi channels status`.
- `WHATSAPP_INSTANCE_CONFLICT`: o nome pertence a uma instância não-WhatsApp ou a um canal ligado a outra instância. Uma instância soft-deletada falha com `USAGE_ERROR`: rode `ravi instances restore <name>` antes.

Saúde: `ravi channels status` lista cada canal com estado e motivo (`connected`, `starting (pairing_required)`, `starting (qr_pending)`, `reconnecting`, `disconnected (manual_disconnect|logged_out|connection_replaced|qr_reset_failed)`, `failed (missing_dependency)`). `pairing_required` ou `logged_out` → pareie de novo com `connect`. `manual_disconnect` → alguém rodou `disconnect`; `connect` reconecta. `connection_replaced` → outro processo usa a mesma sessão; procure um segundo runner ou uma instância ainda conectada no Omni.

### Migrar uma instância que estava no Omni

Leia antes o aviso de NATS: em hosts que vieram do Omni, o processo PM2 `omni-nats` **é o NATS do Ravi**. Nunca rode `omni stop|start|restart|install` nem `pm2 stop|delete|restart omni-nats`.

Uma instância por vez (o UUID, as sessões e os chats não mudam):

```bash
ravi instances show vendas --json                      # anote o instanceId (UUID): ele não muda
ravi daemon restart -m "whatsapp runner upgrade" && ravi channels restart   # mesmo bundle nos dois, daemon primeiro
omni instances disconnect <uuid>                       # para a instância no lado do Omni
ravi instances connect vendas                          # escaneie o QR novo
ravi instances status vendas --json                    # transport "whatsapp", status "connected"
```

Entre o restart e o `connect` a instância fica muda (eventos do Omni são ignorados e o runner ainda não tem socket). Depois teste uma DM e um grupo: devem cair nas mesmas sessões de antes. Triggers em subjects do Omni (`message.received.whatsapp-baileys.>`, ...) param de disparar: mensagens vão para `ravi.channel.inbound.whatsapp.message.>` (o `data` vira um `WhatsAppInboundEvent`: reescreva os filtros e use `data.ingestMode == "realtime"`), reações para `ravi.inbound.reaction` e lifecycle de instância para `ravi.instances.>` ou `ravi.whatsapp.>` (veja a skill `triggers`).

Não há rollback para o Omni no WhatsApp. O procedimento completo está no runbook do adapter: `ravi specs get channels/adapters/whatsapp --mode runbook`.

## Policies

Policies controlam quem pode iniciar conversa com o bot desta instância:

| Policy | Contexto | Comportamento |
|--------|----------|---------------|
| `dmPolicy=open` | DMs | Aceita qualquer DM |
| `dmPolicy=pairing` | DMs | Só aceita contatos previamente aprovados |
| `dmPolicy=closed` | DMs | Rejeita todos os DMs |
| `groupPolicy=open` | Grupos | Aceita qualquer grupo |
| `groupPolicy=allowlist` | Grupos | Só grupos com rota explícita (`ravi instances routes add`) |
| `groupPolicy=closed` | Grupos | Rejeita todos os grupos |

```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```

## Contact Intake

`contactIntakeMode` controla se DMs recebidas criam/linkam contatos canônicos automaticamente.

```bash
ravi instances show main --json
ravi instances set main contactIntakeMode discovered
```

Modos:
- `off`: não cria/linka contato automaticamente.
- `discovered`: cria/linka contato como descoberto, sem marcar como pendente operacional.
- `pending`: cria/linka contato como pendente.

Isso vale para mensagens novas. Para chats antigos já capturados, use:

```bash
ravi contacts backfill --instance main --mode discovered --dry-run --json
ravi contacts backfill --instance main --mode discovered --create-list crm-analysis-pending --apply --json
```

Contact intake não aprova rotas, não responde por si só e não grava análise CRM. Ele só garante identidade canônica, platform identity e vínculo com o ledger de chats.

## Rotas por Instância

```bash
ravi instances routes list <name>
ravi instances routes show <name> <pattern>
ravi instances routes add <name> <pattern> <agent>
ravi instances routes remove <name> <pattern>             # soft-delete imediato, recuperável com restore
ravi instances routes set <name> <pattern> <key> <value>
```

Padrões suportados:
- `5511*` - Prefixo de telefone
- `group:123456` - Grupo específico
- `thread:abc123` - Thread dentro de grupo (maior prioridade)
- `*` - Catch-all

## Pendências

Quando `dmPolicy=pairing` ou `groupPolicy=allowlist`, contatos/grupos desconhecidos ficam pendentes:

```bash
ravi instances pending list <name>
ravi instances pending approve <name> <id>    # aprova + cria rota
ravi instances pending reject <name> <id> --execute   # rejeita (sem --execute é dry-run, exit 3)
```

## Exemplos de Setup

### Bot público (responde tudo)
```bash
ravi instances create main --agent main --channel whatsapp
ravi instances set main dmPolicy open
ravi instances set main groupPolicy open
ravi instances connect main
```

### Bot WhatsApp do zero
```bash
ravi channels start
ravi instances connect main --agent main
ravi instances set main dmPolicy open
```

### Bot controlado (só contatos aprovados)
```bash
ravi instances create suporte --agent suporte-agent
ravi instances set suporte dmPolicy pairing
ravi instances set suporte groupPolicy allowlist
ravi instances connect suporte
# Quando alguém envia mensagem → aparece em `pending list`
ravi instances pending list suporte
ravi instances pending approve suporte 5511999999999
```

### Multi-instância
```bash
ravi instances create vendas --agent vendas-agent
ravi instances create suporte --agent suporte-agent
ravi instances set vendas dmPolicy open
ravi instances set suporte dmPolicy pairing
ravi instances connect vendas
ravi instances connect suporte
```

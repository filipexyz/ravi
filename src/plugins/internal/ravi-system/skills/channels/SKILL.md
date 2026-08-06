---
name: channels-manager
description: |
  Gerencia canais de comunicação do Ravi. Use quando o usuário quiser:
  - Ver status das instâncias WhatsApp, Slack, Discord, Telegram
  - Conectar ou desconectar contas
  - Configurar policies de DM e grupo por instância
  - Verificar QR code de pareamento
  - Troubleshoot problemas de conexão
---

# Channels Manager

Canais são gerenciados por adapters do Ravi. Para Slack, use a skill nativa
`ravi-system:slack` / `ravi-system-slack` e os comandos `ravi slack ...`.

Cada conta conectada é uma **instância** — a entidade central de configuração do Ravi.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.

Escopo migrado em `ravi channels`: só os comandos de CONFIG (`list`, `show`, `create`, `set`). Os comandos de processo (`start`, `stop`, `restart`, `run`, `logs`, `probe`, `status`) são infra de runner/PM2 fora do contrato de agente — dispensados como `daemon`/`service` (ver MIGRACAO-LEDGER.md, seção "Dispensados", e a spec `cli/channels`).

Taxonomia de saída nos comandos migrados:

- `0` sucesso.
- `1` erro de execução: `CHANNEL_NOT_FOUND` (aqui = config de canal Ravi no DB local, NÃO canal do Slack — o domínio `slack` usa o mesmo code para o recurso remoto dele; desambigue pelo `op`) com `suggestions` de nomes reais, e `CREDENTIAL_CONNECTION_NOT_FOUND` quando `--credential-connection` aponta para conexão inexistente (siga o `suggestedAction` para criá-la; sugestões trazem só ids `provider:connection`, nunca segredo).
- `2` erro de uso (ainda não instalado no parser deste domínio — flags inválidas saem em texto legado).
- `3` freio de escrita — não existe em `channels`: `create` e `set` são declaradas SEM freio (config local reversível: `create` ⇄ `set enabled false`, todo `set` tem `set` inverso; campos anuláveis limpam com `-`). Nessas o freio é você: confira o alvo antes de rodar.

Compact mode: `channels list --fields name,provider,enabled` devolve só esses campos por item.

```bash
ravi channels list --json
ravi channels show ravi-rbbt-slack --json
ravi channels create ravi-rbbt-slack --provider slack --credential-connection main --json
ravi channels set ravi-rbbt-slack enabled false --json
```

Checklist antes de responder sobre canais nativos:

- Consultei `suggestions` do envelope antes de declarar not-found?
- Diferenciei config de canal Ravi (`ravi channels ...`) de canal do Slack (`ravi slack ...`)?

## Slack Nativo

Para qualquer tarefa de Slack, Canvas, threads, topology, replay, delivery ou
presenca nativa, use a skill `ravi-system:slack`.

```bash
ravi skills show slack --json
ravi slack --help
```

## Instâncias (central config)

### Listar instâncias
```bash
ravi instances list
ravi instances show <name>
```

### Conectar nova conta (WhatsApp)
```bash
ravi instances connect <name>                         # cria instância + conecta (mostra QR)
ravi instances connect vendas --agent vendas-agent
```

### Configurar instância
```bash
ravi instances set <name> agent <agent-id>
ravi instances set <name> dmPolicy pairing        # open | pairing | closed
ravi instances set <name> groupPolicy allowlist   # open | allowlist | closed
ravi instances set <name> dmScope per-peer
```

### Desconectar
```bash
ravi instances disconnect <name>
```

### Ver status da instância
```bash
ravi instances status <name>
```

## Modos de Operação

- `active` - Agent responde automaticamente
- `sentinel` - Agent observa silenciosamente, responde só quando instruído

## Policies por Instância

Cada instância pode ter política independente de acesso:

| Policy | Contexto | Comportamento |
|--------|----------|---------------|
| `dmPolicy=open` | DMs | Aceita qualquer DM |
| `dmPolicy=pairing` | DMs | Só aceita contatos aprovados |
| `dmPolicy=closed` | DMs | Rejeita todos os DMs |
| `groupPolicy=open` | Grupos | Aceita qualquer grupo |
| `groupPolicy=allowlist` | Grupos | Só aceita grupos com rota explícita |
| `groupPolicy=closed` | Grupos | Rejeita todos os grupos |

```bash
ravi instances set main dmPolicy pairing
ravi instances set vendas groupPolicy allowlist
```

## Multi-Instância

```bash
ravi instances connect vendas --agent vendas-agent
ravi instances connect suporte --agent suporte-agent
ravi instances set vendas dmPolicy open
ravi instances set suporte groupPolicy allowlist
```

## Troubleshooting

### WhatsApp não conecta
```bash
ravi instances status main    # Ver estado da instância
ravi instances connect main   # Reconectar (mostra QR se necessário)
ravi daemon logs              # Ver logs do daemon
```

### Daemon não inicia
```bash
ravi daemon logs              # Ver erros de startup
# Verificar configuração da instância e credenciais em ~/.ravi/.env
```

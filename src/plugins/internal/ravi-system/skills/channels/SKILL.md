---
name: channels-manager
description: |
  Gerencia canais de comunicação do Ravi via omni. Use quando o usuário quiser:
  - Ver status das instâncias WhatsApp, Discord, Telegram
  - Conectar ou desconectar contas
  - Verificar QR code de pareamento
  - Troubleshoot problemas de conexão
---

# Channels Manager

Canais são gerenciados pelo omni API server (processo filho do daemon). Ravi se comunica com omni via HTTP REST e recebe eventos via NATS JetStream.

## WhatsApp

### Conectar conta
```bash
ravi whatsapp connect                        # conta "default"
ravi whatsapp connect --account vendas       # conta nomeada
ravi whatsapp connect --account vendas --agent vendas --mode active
ravi whatsapp connect --account suporte --agent suporte --mode sentinel
```

### Ver status
```bash
ravi whatsapp status
ravi whatsapp list
```

### Desconectar
```bash
ravi whatsapp disconnect
ravi whatsapp disconnect --account vendas
```

### Enviar mensagem direta
```bash
ravi whatsapp dm send <phone> "Mensagem"
ravi whatsapp dm read <phone>
```

## Modos de Operação

- `active` - Agent responde automaticamente
- `sentinel` - Agent observa silenciosamente, responde só quando instruído

## Multi-Account

```bash
ravi whatsapp connect --account vendas --agent vendas --mode active
ravi whatsapp connect --account suporte --agent suporte --mode sentinel
```

## Troubleshooting

### WhatsApp não conecta
```bash
ravi whatsapp status          # Ver estado das instâncias
ravi whatsapp connect         # Reconectar (mostra QR se necessário)
ravi daemon logs              # Ver logs do daemon e omni
```

### Daemon não inicia
```bash
ravi daemon logs              # Ver erros de startup
# Verificar OMNI_DIR em ~/.ravi/.env
```

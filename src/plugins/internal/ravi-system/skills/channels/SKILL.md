---
name: channels-manager
description: |
  Gerencia canais de comunicação do Ravi. Use quando o usuário quiser:
  - Ver status dos canais (WhatsApp, Matrix)
  - Iniciar, parar ou reiniciar canais
  - Verificar conexão do WhatsApp
  - Troubleshoot problemas de conexão
---

# Channels Manager

Canais são as interfaces de comunicação (WhatsApp, Matrix, etc).

## Comandos

### Ver status
```bash
ravi channels status
ravi channels status whatsapp
ravi channels status matrix
```

### Listar canais
```bash
ravi channels list
```

### Iniciar canal
```bash
ravi channels start <target>
```

### Parar canal
```bash
ravi channels stop <target>
```

### Reiniciar canal
```bash
ravi channels restart <target>
```

## Targets

- `whatsapp` - Gateway WhatsApp
- `matrix` - Gateway Matrix
- `<accountId>` - Conta específica

## Troubleshooting

### WhatsApp desconectado
```bash
ravi channels status whatsapp
ravi channels restart whatsapp
```

### Ver QR code novamente
```bash
ravi service wa
```

### Matrix não conecta
```bash
ravi channels status matrix
ravi matrix status
```

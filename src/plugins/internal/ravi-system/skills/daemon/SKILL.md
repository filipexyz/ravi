---
name: daemon-manager
description: |
  Controla o daemon do Ravi. Use quando o usuário quiser:
  - Ver status do daemon
  - Reiniciar o daemon
  - Ver logs
  - Instalar/desinstalar serviço do sistema
---

# Daemon Manager

O daemon é o processo principal que roda o bot e os gateways.

## Comandos

### Status
```bash
ravi daemon status
```

### Iniciar
```bash
ravi daemon start
```

### Parar
```bash
ravi daemon stop
```

### Reiniciar
```bash
ravi daemon restart
ravi daemon restart --message "Motivo do restart"
```

### Logs
```bash
ravi daemon logs              # Últimas linhas
ravi daemon logs --tail 50    # Últimas 50 linhas
ravi daemon logs --follow     # Acompanhar em tempo real
ravi daemon logs --clear      # Limpar logs
ravi daemon logs --path       # Mostrar caminho do arquivo
```

### Modo Dev
```bash
ravi daemon dev   # Rebuild automático ao editar código
```

### Serviço do Sistema

Instalar como serviço (inicia no boot):
```bash
ravi daemon install
```

Desinstalar:
```bash
ravi daemon uninstall
```

## Arquivos

- **Logs**: `~/.ravi/logs/daemon.log`
- **PID**: gerenciado pelo launchd/systemd
- **Env**: `~/.ravi/.env`

## Editar variáveis de ambiente
```bash
ravi daemon env
```

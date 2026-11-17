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
ravi daemon restart --message "Motivo do restart"
```

### Logs
```bash
ravi daemon logs              # Últimas linhas
ravi daemon logs --tail 50    # Últimas 50 linhas
ravi daemon logs --follow     # Acompanhar em tempo real
ravi daemon logs --clear --execute # Limpar logs (dry-run sem --execute)
ravi daemon logs --path       # Mostrar caminho do arquivo
```

As leituras de log executam imediatamente. A limpeza é destrutiva: sem
`--execute`, `logs --clear` retorna o plano com exit 3 e não chama o gerenciador
de processos; repita com `--execute` somente depois de revisar o alvo.

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

## Versão carregada e arquivos no disco

`ravi daemon status --json` e `ravi channels status --json` expõem
`runtime.daemon` e `runtime.channels`: `runningVersion` vem do boot,
`diskVersion` vem do pacote instalado, `startedAt` é o início do processo,
`codeStale` e `envStale` indicam código e ambiente defasados. `stale` reúne
esses sinais. Um runner saudável pode continuar com código antigo.

`runningVersion: null` significa identidade de boot não verificável; não
inferir a versão do processo pela versão do disco. `alignment: aligned`
exige identidade verificada e atual nos processos gerenciados.

Siga os comandos de `warnings`: `ravi daemon restart -m "reconcile runtime"`
e `ravi channels restart`, daemon primeiro quando ambos precisam reiniciar.
Status não reinicia nada. `ravi update` obrigatoriamente reconcilia os
processos gerenciados após atualizar; edições de env apenas avisam.

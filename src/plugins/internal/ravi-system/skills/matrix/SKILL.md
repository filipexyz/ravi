---
name: matrix-manager
description: |
  Gerencia contas e comunicação Matrix. Use quando o usuário quiser:
  - Adicionar, listar ou remover contas Matrix
  - Enviar mensagens via Matrix
  - Ver ou criar salas/rooms
  - Convidar usuários para salas
  - Verificar status de conexão
---

# Matrix Manager

Matrix é um protocolo de mensagens federado. Ravi usa Matrix para comunicação entre agents e usuários.

## Gerenciamento de Contas

### Listar contas
```bash
ravi matrix users-list
```

### Adicionar conta (login ou registro)
```bash
ravi matrix users-add <username> -p <password>
ravi matrix users-add <username> -p <password> -h https://matrix.org
```

### Remover conta
```bash
ravi matrix users-remove <username>
```

### Verificar identidade
```bash
ravi matrix whoami <account>
```

### Status de conexão
```bash
ravi matrix status
ravi matrix status <agent>
```

## Contas de Agents

Agents podem ter contas Matrix associadas:

### Registrar conta pra agent
```bash
ravi matrix register <agent>
ravi matrix register <agent> -h http://localhost:8008 -u username -p password
```

### Login de agent
```bash
ravi matrix login <agent>
```

### Logout de agent
```bash
ravi matrix logout <agent>
```

### Listar contas de agents
```bash
ravi matrix accounts
```

## Salas (Rooms)

### Listar salas
```bash
ravi matrix rooms <account>
```

### Criar sala
```bash
ravi matrix create-room <account> "Nome da Sala"
ravi matrix create-room <account> "Sala Pública" --public
ravi matrix create-room <account> "Com Alias" --alias minha-sala
ravi matrix create-room <account> "Com Convite" --invite @user:server
```

### Entrar em sala
```bash
ravi matrix join <account> <room_id>
ravi matrix join <account> "#alias:server"
```

### Convidar pra sala
```bash
ravi matrix invite <target_user> <room_id> --from <account>
```

### Criar DM
```bash
ravi matrix dm <from_account> <to_account_or_user>
```

## Mensagens

### Ver mensagens
```bash
ravi matrix messages <account> <room_id>
ravi matrix messages <account> <room_id> --limit 50
```

### Enviar mensagem
```bash
ravi matrix send <account> <room_id> "Mensagem"
ravi matrix send <account> @user:server "DM direto"
```

## Exemplos

Criar conta e enviar mensagem:
```bash
ravi matrix users-add bot -p senha123
ravi matrix send bot "#geral:localhost" "Olá!"
```

Configurar agent com Matrix:
```bash
ravi matrix register meu-agent -h http://localhost:8008
ravi agents set meu-agent matrixAccount meu-agent
ravi daemon restart
```

Criar sala privada entre agents:
```bash
ravi matrix create-room agent1 "Discussão" --invite @agent2:localhost
ravi matrix join agent2 "!roomid:localhost"
```

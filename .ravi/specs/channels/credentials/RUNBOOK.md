# Runbook De Credenciais De Canais

## Cadastrar Slack

Use `ravi credentials connections add` com `--secret-stdin`.

O segredo deve ser JSON com `appToken` e `botToken`.

## Diagnóstico

1. `ravi credentials connections list --provider slack --json`
2. `ravi credentials connections show --provider slack --connection <id> --json`
3. `ravi credentials policies explain --provider slack --connection <id> --action socket_mode.connect --json`
4. `ravi credentials broker exec --provider slack --connection <id> --action auth.check --dry-run --json`

Nenhum comando deve imprimir o segredo.


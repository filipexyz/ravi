# Slack Operations

Use esta referencia para operacoes nativas de workspace/canal: listar canais,
criar canal, renomear, convidar usuarios, listar membros e listar files.

## Comandos

```bash
ravi slack channels-list --json
ravi slack channels-info <channel> --json
ravi slack members-list <channel> --json
ravi slack files-list --json

ravi slack channels-create "nome-canal" --execute --json
ravi slack channels-rename <channel> "novo-nome" --execute --json
ravi slack channels-invite <channel> <userIds> --execute --json
```

## Regras

- Mutacoes devem ser dry-run por padrao e so executar com `--execute`.
- Antes de mutacoes, confirme scopes com `ravi slack permissions-list --json`
  quando houver erro de permissao ou app recem reinstalado.
- Prefira IDs Slack explicitos (`C...`, `U...`) quando a operacao for sensivel.
- Nao use Omni para operacoes Slack novas.

## Specs

```bash
ravi specs get channels/slack/operations --mode full --json
```

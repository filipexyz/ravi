# Gmail Ravi App / CHECKS

## Checks

- Manifesto válido e descoberto como `gmail`.
- Operações CLI começam com `ravi gmail` e nenhuma contém `sde`.
- Operações registradas usam `--native --connection default`; o fallback
  connector continua disponível fora do manifesto.
- `list` e `read` são read-only; `send` exige `gmail:send`; futuras escritas e
  deleções têm namespaces separados `gmail:write` e `gmail:destructive`.
- Health estrutural funciona sem login Google.
- Testes do cliente cobrem falha de credencial antes da rede, paths/métodos
  oficiais, paginação, envio MIME falso e redaction.
- Nenhum arquivo em `/home/ravi/sde` é alterado.
- Nenhum token, refresh token, client secret ou alias de conta é adicionado.

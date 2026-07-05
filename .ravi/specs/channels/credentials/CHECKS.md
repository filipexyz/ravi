# Checks De Credenciais

- [ ] `ravi credentials connections list --json` não contém `xox`, `xapp`, token ou secret bruto.
- [ ] SQLite contém `secret_ref`, não valor secreto.
- [ ] `read-secret` não existe como comando público.
- [ ] Remoção de connection pode apagar backend secret quando explicitamente pedido.
- [ ] Slack runner falha fechado quando não há connection válida.
- [ ] Env fallback exige flag explícita.


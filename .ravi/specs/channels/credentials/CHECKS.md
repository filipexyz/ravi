# Checks De Credenciais

- [ ] `ravi credentials connections list --json` MUST NOT contain `xox`, `xapp`, raw token or raw secret values.
- [ ] SQLite rows MUST contain `secret_ref` and MUST NOT store the secret value directly.
- [ ] Public CLI help MUST NOT expose a `read-secret` command.
- [ ] Connection removal MUST delete the backend secret only when explicitly requested.
- [ ] Slack runner MUST fail closed when there is no valid connection.
- [ ] Env fallback MUST require an explicit opt-in flag.

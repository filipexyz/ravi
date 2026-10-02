# Runbook Do Roadmap

## Sequência Recomendada

1. Criar worktree nova a partir de `origin/dev`.
2. Atualizar specs.
3. Implementar `src/credentials`.
4. Implementar `src/channels/outbound-stream`.
5. Implementar `src/channels/runner`.
6. Portar `src/channels/slack`.
7. Ligar Gateway -> `CHANNEL_OUTBOUND`.
8. Rodar testes focados.
9. Rodar typecheck/build.
10. Fazer smoke real.

## Rollback

Se Slack nativo falhar no piloto:

- parar `ravi channels`;
- manter `ravi daemon` rodando;
- desabilitar ou remover a instância Slack nativa;
- remover/disable a connection Slack se o erro for credencial;
- manter intactas as instâncias WhatsApp (`channels/adapters/whatsapp`): o
  WhatsApp roda no mesmo `ravi channels`, então parar o runner também derruba
  essas instâncias. Prefira desabilitar só a instância Slack. Não existe
  rollback do WhatsApp para o Omni; veja o runbook do adapter.

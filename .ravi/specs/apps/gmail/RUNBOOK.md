# Gmail Ravi App / RUNBOOK

## Debug Flow

1. Rode `ravi apps check gmail --json`; esse check não exige credencial.
2. Rode `ravi apps show gmail --json` e confira operações/permissões.
3. Para falha de leitura nativa, confira a conexão `gmail:default` no broker de
   credenciais. Para o fallback anterior, confira `ravi connectors list --json`.
4. Não procure tokens em arquivos SDE; onboarding de credencial Gmail no broker
   está fora da Fase 1.
5. Para envio, confirme `gmail:send` e o fluxo de step-up. Nunca use envio real
   como smoke test.

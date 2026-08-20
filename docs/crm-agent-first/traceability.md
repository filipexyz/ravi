# Rastreabilidade — CRM agent-first

| Fonte da análise | Implementação | Teste/critério |
|---|---|---|
| RT-F1, INC-1 | mapeamento de alvo inexistente em mutações | código específico e ação sugerida |
| RT-F2/RT-F3, INC-2 | validação central de enum, data e intervalo | erro de uso uniforme, nunca lista vazia silenciosa |
| RT-F4/RT-F10, INC-3 | mensagens, caminhos de metadata e ajuda | erro acionável em texto e JSON |
| RT-F5–RT-F8, INC-4 | paginação, resposta única e compatibilidade | contrato estável e consumidor preservado |
| RT-F9/G-12, INC-5 | schema normativo e estados publicados | schema e relatório com papéis distintos |
| RT-F11/CL-7 | journal, confirmação e leitura pós-efeito | resultado aplicado, não aplicado, parcial ou indeterminado |
| U-01–U-17 | fachada CRM | intenção, plano, confirmação, verificação e recuperação |

## Estado atual

- INC-1 e INC-2: `implemented`; os testes de validação foram escritos e aguardam
  a rodada única de validação.
- Fachada CRM: `implemented`; o teste de plano, aprovação vinculada e consumo
  único foi escrito e aguarda execução.
- INC-3 a INC-5 e contratos SDK: permanecem no escopo da PR e só serão marcados
  como concluídos após a revisão dos contratos gerados.

## Consumidores

- comandos CLI existentes;
- registro de comandos e gateway;
- SDK TypeScript, OpenAPI e SDK Swift gerados;
- `contacts profile --include-crm`;
- agentes e skills que usam operações CRM;
- scripts e consumidores legados de aliases.

## Estados de evidência

- `planned`: requisito mapeado, ainda sem código;
- `implemented`: código criado;
- `test-written`: teste criado, não executado localmente;
- `ci-pending`: aguardando execução no PR;
- `verified`: aprovado pelo CI e revisão do PR.

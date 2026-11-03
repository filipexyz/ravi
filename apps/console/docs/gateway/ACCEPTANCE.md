# Equivalência funcional e de segurança

A comparação usa os invariantes v2 no dispatcher novo. Nenhuma contagem do E2E
histórico foi transferida para esta versão. Os resultados executados e hashes
finais são registrados separadamente no relatório da entrega.

| Invariante | Prova no código atual |
| --- | --- |
| Criar/listar/abrir; mensagens e histórico privados | Ravi `bridge/service.test.ts`, `sdk/gateway/console.test.ts`; Fleet `gateway-ravi.integration.test.ts` |
| Assinatura, audience, nonce, TTL, replay e pins | Ravi `console-auth.ts` e testes de gateway/service; Fleet `gateway-ssh.node-fixture.ts` |
| Pessoa A/B, projeto/enrollment/sessão e recibo | Ravi suíte de serviço pelo handler HTTP e teste de controles existentes |
| Envio único, resposta perdida, conflito de payload, outbox | Ravi suíte de serviço + Fleet pareado com SQLite/SSH reais |
| Aprovação exata, owner atual, versão/digest, sem concessão futura | Ravi suíte de serviço, callbacks de runtime existentes |
| Revogação nova mesmo em comando negado; rejeição de revisão antiga | Ravi suíte de serviço/gateway; expiração por tick |
| Filho não amplia autoridade; admin local não substitui pessoa | Ravi scope/runtime-request-context e suíte ampla de runtime/context-registry |
| Cancelamento aceita antes de terminar; preparação falha; recuperação incerta | Ravi suíte de serviço; Fleet pareado confirma cancelamento de turno queued |
| SSE cursor/replay/owner, leitura não renova lease | Ravi gateway; Fleet SSH prova streaming incremental/cancel; integração pareada |
| Controle de sessão restrito e sem propagação | Ravi controle set-display real, retry/conflito/owner; set-model propagate negado |
| Falha depois do efeito não autoriza reexecução | Ravi trigger SQLite aborta auditoria após set-display; retry desconhecido não desfaz mudança posterior |
| Sessão web/policy revalidadas após handshake; resultado incerto preservado | Fleet `gateway-backend.integration.test.ts`, Postgres real e signer real, Vault/SSH simulados |
| Browser/canal/automação e confirmação de entrega | Ravi origens assinadas sem web session; Fleet Postgres delivery integration |
| Permissão de configurar separada de enviar e de capacidades | Fleet authorization/bridge.test.ts |
| UI retry/aprovação/cancelamento/perda de acesso, desktop/mobile | Fleet human-bridge.browser.test.ts, backend remoto simulado; UX.md |
| Um contrato de DTOs | `scripts/sync-ravi-gateway.ts --check`, usando codegen Ravi; todos SDKs e OpenAPI regenerados |

O teste pareado usa listener Ravi, journal SQLite, HTTP e SSH reais, mas um
executor de turno fixture. O teste de browser usa Next, OIDC e Postgres reais,
com respostas remotas simuladas. As suítes nativas exercitam providers por suas
fixtures; não houve inferência real nem teste de sandbox numa VPS nesta entrega.

A remoção do protocolo antigo é código revisável nos dois lados, sem fallback.
Sua ativação operacional depende de rollout coordenado autorizado; não ocorreu
corte de tráfego, migração de canais vivos, deploy ou restart nesta entrega.

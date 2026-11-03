# Estado e limites — 23/10/2026

## Implementado na revisão Console 96bb3be

OIDC single tenant, Pages self-hosted, Bases, integração Executor com delegação,
publicação privada e bloqueio operacional do motor IA do Pages. O código compartilhado
de IA/Workflow permanece; isso não representa motor ativo nem correção da falha histórica.

## Evidências históricas do staging, não reexecutadas nesta publicação

| Cenário | Resultado reportado |
| --- | --- |
| Console SSO com IdP neutro de teste | PASS, 5 checks |
| Executor UI/SSO/negativas | PASS, 7 checks |
| Console desktop/mobile | PASS, 14 checks |
| Pages sem IA, Bases/retry/negativas | PASS, browser 6 + SQL 9 |
| Entrypoints IA bloqueados sem fetch | PASS, 5 checks |
| Backup pós-retirada IA e restore isolado | PASS, rede/TLS, browser 6 + SQL 10 |
| Ravi isolado: login humano e persistência após restart | PASS; implementação Ravi separada, não incluída neste snapshot |
| Vínculo positivo de autor por `ravi link` | NÃO VALIDADO; caminho Slack cancelado |

As provas operacionais privadas não foram publicadas. Builds, testes browser, deploys,
backups e restaurações **não foram executados de novo** para criar este repositório.
O teste full-source no container falhou por fonte Mail ausente e não foi contado como PASS;
a prova de entrypoints implantados é distinta. Upgrade/rollback tiveram provas históricas
entre versões anteriores; não representam teste de nova instalação deste snapshot.

## Fora do aceite

- IdP real/grupos do cliente não homologados; Keycloak de teste não é o IdP do cliente.
- Bridge e conversas com agentes nas instalações ainda propostos.
- Nenhuma garantia de HA, zero downtime, SLA, carga ou DR externo. Backup local não é DR.
- Licença/billing/distribuição comercial central não implementados aqui.
- Não houve alegação de correção da seleção intermitente de ferramentas do antigo chat.
  Esse motor foi retirado do escopo e desabilitado; não deve ser reativado para validar o Fleet.

Esta publicação é um pacote de código e infraestrutura de referência, **não produção pronta**.

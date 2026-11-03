# SSE integrado ao onboarding — aceite local

Composição: `e501e5d3909644e4238105f83cdf133dbbabc8a7` +
`5e41ec52fb8aec5daff0cd09e79ff18976e70aaf`. O primeiro candidato e suas provas
permanecem preservados. O complemento não altera schema/migrations, bootstrap,
SSO, navegação, membros, criação de projeto ou configuração de implantação.
O hash final desta composição é registrado no handoff após build/scan/commit.
Build standalone local final PASS: Next16.2.6, compile/TypeScript/118páginas,
configuração sintética e IAoff; não imagem/deploy. Lint e diff-check PASS.

## Provas novas nesta composição

| Cenário | Resultado / evidência |
| --- | --- |
| Stream/comandos unitários | 19 testes / 68 assertions PASS |
| Fonte SSE + Postgres/session store reais | 8 / 47 PASS, `fleet-policy-test-cQkzii`; identidade admitida sintética, NÃO login real |
| Rota Next HTTPS + Chrome + IdP OIDC + PG reais | 1 / 36 PASS, `fleet-stream-browser-b8Rqn3`, cluster `fleet-pg-test-yhL81L`; login real, cookie/request reais e reconsulta durante a conexão |
| Onboarding/SSO, bootstrap, upgrade, org, membros, pré-requisito | 5/46 +1/63 +1/14 +3/27 +5/41 +1/14 PASS, `fleet-pg-test-pyEeSN`; mesmas limitações das fixtures, Vault sintético |
| Auth/Pages/CLI | 46 / 181 PASS |
| Executor/Bases/IA off | 37 / 128 PASS; testes locais, não gateway Executor HTTP implantado |
| Fleet/cofre/SSH/SSO/Compose | 28 / 152 PASS; SSH loopback real, cofre unitário, Compose parse-only |
| HTTP Fleet | 8 / 52 PASS, processo separado por conter mocks de dependências |

O navegador prova:

- Sem sessão: HTTP401; owner sem grant de projeto:403; B e instância/sessão
  aninhadas divergentes:403/404. Organização divergente:409 com
  `organization_selection_required`, sem dados. Isso é o contrato desta rota,
  distinto do mapper403 de outras APIs.
- Disponibilidade da feature continua obrigatória. Viewer ainda encontra o gate
  nominal legado mesmo com grant de leitura. Não há declaração de migração
  global para roles flexíveis nesta superfície.
- A lê eventos criptografados, recebe novo evento por polling e reconecta por
  Last-Event-ID sem repetir os anteriores. O grant é somente project.read.
- A fixture segura o SELECT de eventos com lock de tabela, depois segura o
  próximo SELECT da sessão. O segundo bloqueio observado em pg_stat_activity
  acontece após a carga/decriptação do lote e antes da emissão. A política é
  revogada enquanto a emissão aguarda. Resultado: HTTP200 já iniciado, somente
  erro SSE genérico, sem conteúdo/cursor/connected do lote descartado. Reconnect
  retorna403. Não há hook de teste no produto ou mock de autorização.
- `reader.cancel()` e AbortController encerram uma conexão enquanto um SELECT
  real aguarda lock. Ao liberar o banco, nenhum novo payload ou decisão de
  emissão aparece. A query em andamento NÃO é abortada pela desconexão.
- Expiração e revogação da sessão persistida durante uma conexão produzem erro
  SSE genérico e fechamento; reconnect401. Uma segunda autenticação OIDC real
  é necessária após expiração; não se ressuscita token expirado/revogado.

## Isolamento e limites

Apenas registros privados sintéticos: duas instâncias disabled/stopped, duas
sessões completed, dois comandos succeeded com attempt_count0/claim_owner null.
Zero runtime_hosts, operações ou dispatch. Nenhum agente, reconciler, provider,
modelo ou conexão de instalação está configurado. O entitlement sintético
permite testar a **leitura**; não há ativação de runtime. Pages IA continua off.

O launcher Node permite somente o socket Unix do cluster e os dois servidores
HTTPS loopback da fixture. O browser permite só essas origens. Prova de rede:
0 sockets externos e 0 tentativas de provider/runtime. Houve **1 tentativa
bloqueada** de metadados de versão do Next dev, antes de qualquer socket, na URL
exata registry.npmjs.org/-/package/next/dist-tags e stack do
hot-reloader-shared-utils. Ela é contada separadamente, não chamada de zero fetch.
Qualquer outra tentativa reprova. O controle não libera acesso ao registry.

Política de leitura e revogação são fixtures SQL explícitas. Publicação humana
via editor/API foi validada no candidato e501, não reapresentada como parte deste
teste. O login aqui usa a configuração inicial OIDC; a topologia combinada de
SSO gerenciado via Vault continua uma prova separada. Não é IdP do cliente.

Revogação é observada por lote, não atômica com rede: bytes já emitidos não são
recolhidos e uma mudança após a última checagem pode concorrer com aquele lote.
Falha depois dos headers fecha com erro SSE, não HTTP401 retroativo. Outros
streams/jobs/provider Ravi, bridge de conversa e migração dos gates nominais
continuam fora deste aceite. Nenhum deploy/SSH/push ou alteração no Ravi ativo.

## Falhas preservadas e comandos

- `fleet-stream-browser-LLs3DY`: enum inválido da fixture (`stopped` no campo
  status; correto `disabled`, com desired/observed stopped). Não era produto.
- `fleet-stream-browser-TdyMrJ`: expectativa403 para org divergente; o handler
  e workspace comprovam contrato409. Asserção corrigida para status+body exatos.
- `fleet-stream-browser-V9uxwB`: segundo login válido mas guia sem grant porque
  a fixture substituía o bootstrap por uma política sem suas12 concessões.
  Agora parte do documento persistido real e comprova as12 antes de acrescentar
  somente o grant de leitura A. Nenhum fallback por role foi adicionado.
- `fleet-stream-browser-Ok9zox`: cenários funcionais passaram, contador total de
  fetch negado reprovou pela consulta de versão do Next. Guard continuou fechado;
  a classificação exata acima distingue framework de provider/saída inesperada.
- Typecheck inicial encontrou tipos de stdout/this/import do launcher novo;
  corrigidos no harness, sem supressão de erros do produto.

```sh
bun test src/server/console/managed-runtime-event-stream.test.ts src/server/console/managed-runtime-commands.test.ts
RAVI_AUTH_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bun scripts/test-project-authorization.ts --streams
bun tests/fleet/run-postgres.ts --stream-browser
bun tests/fleet/run-postgres.ts
```

Os runners criam cluster Unix privado e sempre o encerram em finally. O runner
Next recusa arquivos .env no checkout, usa env sintético e perfil Chrome próprio,
fecha browser/IdP/Next e libera locks em finally. Logs, TLS, tokens de teste,
result.json/network.json ficam fora do Git. Não executar concorrente com outro
Next/build no **mesmo worktree**. A alteração posterior no resumo do runner
apenas identifica Vault ausente/SSH não usado no modo stream, não altera testes.

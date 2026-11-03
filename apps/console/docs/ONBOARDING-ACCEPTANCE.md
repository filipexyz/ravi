# Aceite local do onboarding

## Correções da revisão humana PR1 — provas locais, aceite parcial

Provas novas, causas e limites estão em
[PR1-HUMAN-CORRECTIONS.md](authorization/PR1-HUMAN-CORRECTIONS.md).
Gate obrigatório inclui **metrics3/3 e todas as seis suítes Bases/chat221/221**,
não apenas host/operator/password/capture. A regressão própria passou em PG17
isolado no Mac; também passaram os testes adicionais de principal de serviço e
revogação MCP. O relatório discrimina build, unidades, concorrência e integrações
reais versus doubles, por commit/comando/evidência. O pacote é parcial: propriedade
humana/institucional de API keys precisa de decisão explícita. Linux, revisão
independente R2 e implantação NÃO estão aprovados. As seções abaixo são histórico
e não substituem os limites da matriz atual.

## R2: expiração durante locks — candidato local, revisão independente pendente

R1 recebeu PASS independente em66d5 no limite testado de suspensão/reativação.
A revisão57ca2f5 abriu R2: código CLI/vínculo válido na entrada podia vencer
durante espera e ainda emitir credencial. A correção posterior e sua extensão
de bootstrap estão em [ADMISSION-EXPIRY.md](authorization/ADMISSION-EXPIRY.md):
relógio fresco depois dos locks e checkpoint final com rollback de consumo,
credencial e auditoria. Nenhum deploy; novo hash ainda exige revisão independente.
Build/Next/browser pós-fix e fixtures legadas ampliadas continuam NOT PROVEN.

## R1: marco local anterior (depois repetido pela revisão57ca2f5)

A revisão independente encontrou ressurreição de sessão em e501. A correção e
o inventário Console/Pages/CLI/link estão em
[ADMISSION-RACE.md](authorization/ADMISSION-RACE.md), com concorrência PG real,
rollback, replay e novo login. Não confundir os PASS históricos abaixo com prova
da correção. Build/Next/browser desta revisão ainda não foram repetidos por gate
de recursos; nenhum staging foi alterado. O hash fixado e as verificações finais
ficam no handoff, para nova revisão independente.

## Complemento SSE após e501e5d

A composição adicional de `5e41ec52` está documentada em
[STREAM-INTEGRATION.md](authorization/STREAM-INTEGRATION.md): Next/request/SSO
reais1teste36assertions, fonte PG8/47 e units19/68 PASS; nova regressão de
onboarding/membros/auth/Pages/Bases/IAoff. Nenhum runtime/agente executado.
Essa seção e o handoff final distinguem as provas novas das provas e501 abaixo.
Build standalone final PASS: compile, TypeScript e118páginas, env sintético/IAoff.
Lint dos fontes novos/afetados e diff-check PASS. Scan e hash final são registrados
no handoff após conferir bytes/modos do candidato.
Não é aceite de implantação nem migração global de roles ou outros streams.

Base preservada `feat/org-onboarding`/`5c775113`, base privada `05aa5ba`.
A composição local `feat/onboarding-authorization-integration` preserva os
checkpoints58f2ee6/01f13d4/74226ed e integra o contrato fixado42991d54.
Esta seção atual prevalece sobre os checkpoints históricos abaixo. Não é aceite
de staging/produção, IdP cliente, runtime Ravi provider ou ponte conversacional.

## Candidato e501e5d — diretório/lifecycle e disponibilidade de criação

Implementados: org settings DTO somente id/name/slug; diretório separado com
members.read; lifecycle de identidades já provisionadas com read+manage,
CAS/recibo/efeito/revogações na transação do core e último gestor efetivo protegido.
Sem papéis/grants implícitos, convites/usuário stub ou authz combinada. Bootstrap
continua EXATAMENTE12 ações. POST projects e Page default separam disponibilidade
de política; demais gates legados não foram migrados em massa.

| Prova da composição atual | Resultado e escopo |
| --- | --- |
| Next HTTPS + navegador + PG + IdP real | 1 teste/91 assertions PASS, `fleet-browser-test-79LxTd`: bootstrap/guia/restart; settings mínimo; billing+grants cria projeto/Page sem grant/membership; indisponibilidade de projects/Pages nega; diretório read-only, suspensão UI/teclado, CAS/replay e revogação |
| PG Fleet/SSO | 5/46 PASS, IdP real em um cenário, cofre sintético |
| Bootstrap/upgrade/org/pré-requisito | 1/63 +1/14 +3/27 +1/14 PASS; upgrade populado74→75→76, repeat no-op, rollback/bootstrap e12 grants; `fleet-pg-test-Mk9qoL` |
| Lifecycle membros integrado | 5/41 PASS: diretório mínimo, escopo, read/manage separados, CAS e retry concorrente, último gestor/remoção recíproca, rollback receipt/audit/sessão, admissão proibida, revogação exata Console/Pages/claims/CLI/device/link; reativação não ressuscita sessões nem altera grants |
| Core membros | 8/54 PASS, `fleet-policy-test-4uPDeJ`, including lock/policy/actor/last-manager invariants; identidade sintética |
| Core bootstrap/autorização | 10/74 PASS, `fleet-policy-test-VrX2OE`; preparo migrado preservado |
| Consumidores policy/Pages/Bases/CLI/inbox/criação | 13/162 PASS +11 cenários editor1280/390; `fleet-policy-test-63sc19`, `fleet-policy-editor-om2ZzA`; não é gateway Executor HTTP/Ravi provider |
| Fleet/settings/nav/engine/Compose/SSH | 52/281 PASS; SSH loopback real, Compose parse-only, demais limites das fixtures |
| Next route HTTP Fleet | 8/52 PASS, auth/CSRF/body-bound/ator servidor; dependências sintéticas |
| Auth/Pages/CLI e Executor/Bases/IAoff | 46/181 e37/128 PASS; nenhuma IA/credencial externa |
| Vault Raft local real | 14checks PASS, `fleet-vault-test-jpQ7HR`; TLS/KV2/CAS/escopo/sealed/revoke/audit e restore quiescente, não Docker/DR |
| UX | antes pR6Jld, depois FIxUZ2/VCV2FZ, consulta JrNvqJ/negado BsfDOp1280/390; foco/Escape/retorno e aviso de reativação; screenshots Next79LxTd inspecionadas |

Primeira fixture membros falhou22P02 por usar user_status='suspended' (o enum é
disabled); correção somente na fixture, não no produto/asserção de admissão.
Primeiro typecheck apontou consumidores ainda usando settings.members e tone
inválido: nomes agora vêm do diretório mínimo independente e autorizado, sem
ampliar gates de audit/feedback/connectors. Outra falha foi tipo genérico RowList
na comparação da fixture; comparação por arrays preserva os dados/asserção.
Runner core sem RAVI_AUTH_TEST_PG_BIN recusou antes de iniciar; execução posterior
informou explicitamente o binário local. Falhas preservadas, não contadas PASS.

Typecheck e lint da composição passaram (único warning: next-env.d.ts gerado
ignorado pelo ESLint; lint dos fontes sem erros). Build final após a orientação
de políticas no guia PASS: compile/TypeScript118páginas, env sintético/IAoff.
Guia validado em componente1280/390 e7checks de conflito/retry; a prova Next91
precede somente essa adição explicativa. Scan1658arquivos:17achados todos idênticos
aos fixtures/schema anteriormente revisados,0novos; snapshot final/commit
registrados no handoff após conferir bytes e modos.

### Limites atuais e implantação

- O bootstrap dá configuração, não members/create/dados; primeiro steward publica
  concessões adicionais explicitamente no editor. Não há caminho de provisionar
  novos usuários/IdP/convites ou combinar mudança de papel com membership.
- Diretório limitado a1000 registros; invariant core a1000 membros ativos,
  excesso falha fechado. Sem promessa de escala/carga ou revogação SCIM ao vivo.
- Teste billing provou POST/formulário/efeito, NÃO migração dos gates GET das
  demais telas. Mapeamento legado de role de algumas features permanece gap.
- Ativação em instalação existente exige plano auditável de grants; não executar
  bootstrap/regrant por label, nem deploy desta branch sem autorização separada.
- Custódia Vault/manual versus KMS, SSO cliente, topologia combinada real,
  rollover/recovery operacional e produção continuam gates externos.
- Incidente Page demo409 e bridge/runtime-provider/inbox cliente/outros streams/
  jobs/Executor HTTP não foram corrigidos/implementados por esta integração.
  A única extensão SSE posterior está delimitada na seção inicial.

## Consumidores185beb9 e navegação — checkpoint incremental

- Merge automático preservou hunks org settings e os de projeto da outra frente.
- PG consumers12/135 PASS, editor real10cenários1280/390, runner76→76/no-op;
  evidências `fleet-policy-test-Six4Gq` e `fleet-policy-editor-yKUQFs`. Não confundir
  sentinela76→76 com upgrade histórico74→75 ou autorização no Ravi instalado.
- Navegação unit5/50 PASS; shell+OrgArea sintéticos1280/390 policy-only e negado,
  sem projeto e sem console.settings legado. Endpoint real conserva seus gates.
- e2c2ef5 e próximo catálogo members NÃO estão neste checkpoint. DTO settings
  mínimo/members separado e affordance de criação ainda pendentes. Build58f2ee6
  acima não é build desta nova composição.

## Complemento e2c2ef5 — checkpoint incremental seguinte

- Core9/64 e consumers13/162+editor10 PASS na composição76; preparação da tabela
  de bootstrap validada e todas as novas assertions preservadas.
- Next/PG/IdP real1/54 PASS: mesma identidade configura organização, publica
  grants explícitos por API normal, criação sem create/dados negada, formulário
  cria projeto+Page, não cria membership/grant e revogação nega nova criação.
  Evidência `fleet-browser-test-URqiRF`; PG `fleet-pg-test-uGgirr` terminou.
- PG onboarding5/46, bootstrap1/61 (EXATAMENTE12), upgrade1/14, org3/27 e
  prerequisite1/14 PASS. Bootstrap antes falhou porque o teste antigo assumia
  todo catálogo; agora compara lista literal12 e nega todas as demais ações.
- Fleet/settings/engine/nav49/240, HTTP7/41, Executor/Bases/IAoff37/128 PASS.
- Auth/Pages/CLI46/181 PASS. Primeira execução41PASS/4FAIL procurava DB padrão:
  fixture de private-auth agora injeta decisão explícita exata e testa revogação;
  produção conserva canAccessProject como default. Não é prova unit de DB/policy.
- Typecheck inicial encontrou cauda inválida no validator GERADO de Next dev,
  inclusive após servidor parar. Guardado recuperavelmente em diretório privado,
  types regenerados com next typegen; resultado final registrado no checkpoint.
- Próximos:42991d54, DTO/diretório/lifecycle, gate de disponibilidade POST de
  criação e novas regressões; nenhum aceite de implantação ou custódia.

## Integração parcial em validação (24/10/2026 UTC)

| Prova nova | Resultado atual |
| --- | --- |
| Fleet/cofre/SSH/admissão + engine | 38 testes/183 assertions PASS; SSH local real, demais limites conforme fixtures |
| Fronteira HTTP Fleet | 7 testes/41 assertions PASS, funções Next reais/dependências sintéticas; ações por recurso e ator do servidor |
| PG/SSO | 5/46 PASS; 76migrations, IdP HTTPS real em um cenário, Vault sintético |
| Bootstrap integrado | 1/59 PASS: IdP real, concorrência, falha DB após initializer reverte identidade/sessão/policy/consumo; replay não regranta política revogada |
| Upgrade populado | 1/14 PASS:74→75→76, preserva dados/hashes e não concede acesso por label legado |
| Ações de organização | 3/27 PASS: custom role/rename, owner-admin sem grants, recurso/escopo, read/manage, revogação de retry e audit de negação persistido |
| Browser real | 1/27 PASS: SSR bloqueia entrada antes da hidratação; uma entrada, IdP real, bootstrap/API/CSRF/negação por policy e sessão preservada após restart local |
| Core contract isolado sobre composição | 8/56 PASS após correção autorizada apenas do preparo da fixture; nenhuma mudança no engine/assertions |
| Preparo do contrato | 1/14 PASS: cria pré-requisito standalone ou valida/reutiliza tabela0073 real; rejeita drift de colunas/nullability sem substituir a tabela |
| UX com dados sintéticos | Cinco telas em consulta/negado1280/390 PASS; SSO form1280/390 e guia conflito/retry7checks por tamanho PASS; imagens inspecionadas |
| Regressões auth/Pages/CLI | 45/177 PASS |
| Regressões Executor/Bases/IAoff | 37/128 PASS; testes legados de herança de projeto NÃO provam a política nova |
| Vault Raft real isolado | 14checks PASS novamente, quiescent restore, versão1.21.0 fixa de fixture, não recomendação operacional |
| Compose manual | parse-only1/21 PASS; nenhum daemon iniciado |
| Build produção | PASS nesta composição: compile, TypeScript,117 páginas; env sintético/IAoff, sem Docker/deploy |
| Lint | PASS em todos os TS/TSX alterados e novos; build inclui typecheck da composição |
| Secret scan | Snapshot final exigido antes do commit; resultado/manifesto privado registrado no handoff, não prova de deployment |

Falhas intermediárias preservadas: upgrade esperava75 antes de integrar0074;
fixture de política tentou administrators vazio (core recusou corretamente);
mock HTTP omitia novo export, depois comparava JSON pela ordem das chaves;
segundo login da fixture reutilizava cookies SSO e não tinha tela de senha (agora
limpa somente seu contexto descartável); alteração inicial do guia escondia a
recuperação em erro de rede (corrigida,403/401 continuam sem dados). Nenhuma dessas
falhas foi apagada ou apresentada como sucesso anterior.

O setup real falhou duas vezes por aceitar entrada SSR antes dos handlers: agora
input/submissão ficam bloqueados até hidratação. Teste segura scripts, confere o
estado bloqueado e libera uma única entrada normal. A fixture core falhou42P07;
o helper autorizado valida schema exato ou cria quando ausente, sem DROP/truncate.
O teste CSRF inicialmente falhou TLS no cliente separado de Playwright; agora usa
CA explícita da fixture (não ignoreHTTPSErrors). Nenhum segredo real foi utilizado.

Limites deste checkpoint: consumidores185beb9, navegação e split do DTO settings
ainda não integrados; placeholders members/tokens vazios são transitórios e NÃO
o contrato final aprovado. Ações members aguardam hash fixado da frente responsável.
Rollout com membros existentes e SSO roleGroups antigo NÃO é seguro
sem migração explícita. Não há fallback owner/admin. Custódia e deploy seguem gates
externos, não justificativas para alterar staging.

## Provas históricas de5c775113 (23/10/2026 UTC, não reexecução da composição)

| Cenário | Resultado e alcance |
| --- | --- |
| Serviço/contratos/cofre/SSH/policy OIDC | 27 testes/127 assertions; stores/IdP sintéticos onde indicado; SSH2 real loopback nos 4 testes de transporte; socket Node 24 real para o lookup OIDC |
| Fronteira Next HTTP | 6 testes/34 assertions; funções reais de route, dependências sintéticas, auth/CSRF/JSON/limites/ator/erro sanitizado |
| Auth/workspace/Pages auth/CLI regressão | 45 testes/177 assertions; não são smokes remotos novos |
| Executor/Bases/Pages engine regressão | 37 testes/128 assertions em 4 arquivos; preservação de comportamento existente, não aceite da futura política de projeto |
| PG isolado | 75 migrations fresh + repeat no-op;5 testes/46 assertions; concorrência, membership revalidada, credenciais/instalações e SSO |
| Bootstrap concorrente | 1 teste/27 assertions, PG + IdP HTTPS real + browser; um owner, sem replay/takeover; conclusão do guia persistida |
| Upgrade74→75 | 1 teste/8 assertions; identities/membership/org/session preservadas, grupos vazios adicionados, repeat no-op |
| Candidata SSO real | incluída nos5PG: login oidc-provider real, ativação e seleção persistidas; Vault sintético e transporte loopback injetado só na fixture, não full deployed E2E |
| Next HTTPS/browser/PG/IdP | 1 teste/15 assertions: setup real, guia/API, negativas viewer/outra org, segredo recusado sem Vault, snapshot concorrente e persistência após restart local |
| Cofre real não-dev/file | 14 checks: TLS/KV2/CAS/escopo/versões/sealed/revogação/audit/restore isolado |
| Cofre real não-dev/Raft | os mesmos14checks em Raft single-node; cópia quiescente em diretório novo, não live snapshot ou DR externo |
| Compose manual | parse-only do modelo base+overlay e21 assertions; sem daemon/start/pull; imagem sintética impossível no teste, não versão de release |
| UX | componentes reais1280/390; formulários, label/focus e sem overflow; guia stale→falha de refresh→nova revisão→retry→conclusão7checks por tamanho; shell real também inspecionada |
| Typecheck/lint/diff | PASS depois da correção do lookup; repetir após integração de commits |
| Build produção | Next 16.2.6 standalone PASS após a correção do lookup: compile, TypeScript e 117 páginas estáticas; env sintético/IA off, sem imagem Docker nem deploy |
| Secret scan | Gitleaks 8.30.1, snapshot de 1.606 arquivos: 17 achados brutos, todos idênticos aos fixtures/identificadores revisados na base; zero novos/não classificados. Não foi scan bruto sem alertas |

## Comandos reproduzíveis

Dependências via `bun install --frozen-lockfile`. Não herdar envs de produção.

```sh
bun test tests/fleet/service.test.ts tests/fleet/vault.test.ts tests/fleet/ssh.integration.test.ts tests/fleet/sso-policy.test.ts
bun test tests/fleet/http-contract.test.ts
bun test tests/fleet/operational-template.test.ts
bun tests/fleet/run-postgres.ts
bun tests/fleet/run-postgres.ts --browser
RAVI_AUTH_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin bun scripts/test-project-authorization.ts --contract
bun tests/fleet/run-vault.ts
bun tests/fleet/run-vault.ts --raft
bun tests/fleet/preview-current.ts onboarding conflict
bun run typecheck
```

As regressões adicionais usam `src/lib/auth/oidc.test.ts`,
`src/server/console/{workspace,ravi-control-workspace}.test.ts`,
`src/server/console/pages/{auth,auth-start}.test.ts`,
`src/server/cli/device-auth.test.ts`,
`src/server/console/executor/protocol.test.ts`,
`src/server/console/bases/{access,idempotency}.test.ts` e
`src/server/console/pages/chat/engine.test.ts`. O arquivo inexistente
`pages/connectors/exec.test.ts` não foi contado como teste executado.
Alguns testes legados ainda preservam herança de projeto por membership; não são
prova da regra nova, cuja implementação pertence à frente de autorização.

HTTP mocks devem rodar separados de outras suites de auth para não contaminar o
cache de módulos do Bun. As fixtures PG exigem binário PostgreSQL17 local e socket
Unix próprio; browser exige Chrome no path macOS explícito. Elas não ligam Docker
nem usam banco/IdP/Chrome/Ravi ativos do usuário. Fixture Vault usa binário
darwin/arm64 checksum-pinado1.21.0; não é recomendação de release de produção.
Generated fixture credentials are synthetic, private and never emitted as proof.

## Falhas preservadas e limites das provas

- PG serialização JSON e primeiro dono falharam nas iterações iniciais. Estado
  atual passa; não atribuir causalidade do primeiro erro sem reproduzi-la.
- HTTP test primeiro falhou por mock sem export e depois detectou inicialização
  antecipada de consumidor sem relação. Mock e dispatch corrigidos; sem dizer que
  antes havia acesso eager ao Vault (era lazy).
- Primeiro browser Next via proxy fixture expirou esperando load; Next havia
  respondido200. Prova seguinte usou HTTPS direto e passou, sem atribuir a causa do
  proxy sem reprodução. No encerramento dev, esbuild registrou deadlock; não é
  prova de shutdown limpo. Prova funcional inclui restart do processo, não produção.
- Raft init ultrapassou5s durante eleição. Só o limite administrativo da fixture
  foi aumentado para30s; deadline do consumidor de segredos continua5s.
- Parse Compose inicial recusou env files ausentes. Fixture nova fornece arquivos
  vazios explícitos. JSON normalizado omite false/zero: os guards também conferem
  YAML original exato, sem inferir limites de runtime a partir do parse.
- Revisão final reproduziu `ERR_INVALID_IP_ADDRESS` no Node 24: o socket pediu
  `lookup(all=true)` e o callback devolveu string. O adaptador agora suporta os
  dois formatos nativos; regressões verificam ambos e uma conexão Node real. A
  fixture de SSO anterior injetava transporte local e não cobria esse callback.
  Não houve liberação de loopback no consumidor público nem redução de TLS/SSRF.

O scanner foi conferido contra o archive e checksum oficial já verificados na
publicação da base. A reconciliação usa path, linha, regra e SHA da linha contra
`docs/SECRET-SCAN-REVIEW.json`; allow-comments não escondem achados. Snapshot,
manifesto e relatório redigido ficam fora do repo em diretório privado, não junto
de credenciais. Só arquivos Git/candidatos regulares entram, sem `.env` real,
`.private`, symlink, dados ou builds. O commit deve corresponder a esse snapshot;
qualquer alteração posterior exige nova revisão.

## Pendente / NÃO COMPROVADO

- Extensões além da composição local acima: runtime-provider/inbox cliente,
  streams/jobs, gateway Executor HTTP e migração de instalação existente.
- SSO gerenciado + Vault + Next/browser na topologia real com política de rede
  aplicada, onboarding com IdP do cliente, deploy/restart/rollback das imagens.
- Vault image/UID/cgroup/mounts em Docker, live Raft snapshot, token rotation no
  bind montado, custódia manual versus KMS/HSM, recuperação operacional externa.
- Certificados/DNS reais, HA, capacidade/SLA/RPO/RTO e DR externo.
- Ponte de conversa Console↔Ravi e delegação de autorização não implementadas.
- Incidente da Page demo409 e falha histórica do chat removido não são corrigidos
  nem reclassificados por este pacote. IA, voz, mail e Slack permanecem fora.

Não há push/PR, SSH, deploy, alteração no Ravi ativo do Mac ou custódia de segredo
real. Gates externos não foram convertidos em PASS por testes de fixtures.

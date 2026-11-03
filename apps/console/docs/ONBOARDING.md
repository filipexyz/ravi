# Onboarding local — implementação e operação

Uma instalação, uma organização. Este pacote adiciona primeiro acesso, guia e
Configurações de login OIDC, credenciais e transportes Ravi. Não implanta o pacote,
não implementa conversa com agentes nem muda a autoridade do Ravi pelo SSH.
IA do Console/Pages permanece desligada.

## Contrato para a frente de permissões

Autenticação resolve identidade verificada e membership ativa; o corpo da request
nunca define ator/role/org. Os consumidores administrativos usam as ações tipadas
`organization.{settings,onboarding,sso,credentials,installations}.{read,manage}`
do único motor de autorização, além do contrato separado de membros abaixo. Nome de papel não concede poder, manage não implica
read e cada efeito revalida a política atual na mesma transação. A negação é
auditada e confirmada antes de retornar403, sem efeito ou acesso ao cofre.
Membership na org não deve virar acesso a todo projeto; ravi link não é grant.
`admissionGroups` restringe a entrada de membros existentes independentemente do
nome de papel. Não cria grupos de política, membership, promoção ou grant/JIT.
Snapshot assinado de grupos pertence à sessão; não equivale a SCIM em tempo real.

| Responsabilidade desta branch | Seam/arquivos para integração controlada |
| --- | --- |
| Login/bootstrap/identidade | `src/lib/auth/{session,oidc-store,oidc-runtime,oidc-client}.ts`; callbacks |
| Entrada administrativa | fleet route: `getConsoleApiAuthState` → `getConsoleWorkspace` → ação tipada no consumidor; `/fleet/access` projeta observações, não capabilities reutilizáveis |
| Revalidação do ator | `FleetActor`, `assertFleetActor`, transações `postgresFleetStore`, `FleetSsoService`, `OnboardingService` |
| Dados de onboarding | migration `0073_fleet_onboarding`, journal idx74; autorização0074 idx75; `oidc_groups` em browser sessions; bootstrap e concessão na mesma transação |
| Navegação | `OrgArea`, `console-paths.ts`, rotas `[org]/{sso,credentials,installations,onboarding}` |

Políticas/grants/enforcement de projeto/admin de acesso pertencem à outra frente.
Integrar commits, não copiar worktrees sujos. Resolver schema agregado, journal e
nav explicitamente; regressão conjunta antes de qualquer deploy. `workspace.ts` e
`feature-access.ts` não foram reimplementados por este pacote: somente POST
projects/sem id e seu gate Page default passaram a verificar disponibilidade,
com autoridade no serviço transacional. GET/PATCH/DELETE/features alheias mantêm
seus contratos; não alegar migração global das listas de roles.

## Diretório e ciclo de admissão

`GET /api/console/settings?scope=org` devolve somente id/name/slug com settings.read.
`GET /api/console/fleet/members` exige members.read e devolve userId/name/email/
status/version e currentUserId, sem policy/grants/tokens/projetos. Limite1000;
excesso é erro explícito, nunca truncamento apresentado como lista completa.

`POST /api/console/fleet/members/status` aceita exclusivamente operationId UUID,
userId UUID, expectedVersion opaca e status active/suspended/removed. Ator/org
vêm da sessão OIDC, nunca do body. Exige members.read E manage atuais; não aceita
delegação de instalação. Dentro da MESMA transação: Fleet lock → policy lock →
decisões → recibo/CAS → efeito/revogações/audit → invariant do core → commit.
Uma exceção reverte tudo, inclusive recibo/audit; não prometer audit durável de
negação nesse wrapper, diferente da leitura/consumer Fleet que confirma negações.

Não há operação combinada membership+política. Mudar estado não altera grants;
reativação pode tornar grants anteriores úteis novamente e exige novo login/link.
Suspender/remover revoga browser sessions, Pages sessions/claims, CLI sessions/
autorizações de dispositivo e vínculos/pedidos Ravi associados ao alvo na org.
Não desativa a máquina compartilhada nem toca sessões de outras pessoas.
Um gestor humano ativo com authorization.read E manage efetivos deve sobreviver;
nomes owner/admin não contam. A verificação mantém locks até commit, limita1000
ativos e falha fechado. Erros CAS exigem atualizar/revisar; falha de transporte
mantém operationId/input para retry. Revogação da permissão nega inclusive replay.

Interface Members remove convites, criação de stubs e seleção de papéis. Estas
rotas legadas são negadas explicitamente no Fleet/OIDC. Identidades invited,
sem IdP provisionado ou usuário disabled não podem ser admitidas por este fluxo.
Novas identidades/provisionamento/convites não estão implementados neste pacote.
Configuração política é separada e requer authorization.read/manage; um gestor
de membros sem esses grants não pode atribuir papéis. O guia/bootstrap não
concede automaticamente members/create: publicar concessões no editor após
primeiro login é uma decisão explícita, sem requisito de ligar features opcionais.

## Primeiro dono: confiança inicial é preparação operacional

O operador prepara banco migrado, origem HTTPS, UUID fixo da instalação, chave de
sessão e cliente OIDC inicial. `RAVI_OIDC_CLIENT_SECRET_FILE` pode apontar a arquivo
absoluto protegido; a opção de segredo em env legado ainda é lida se não há file.
Nunca imprimir/capturar o conteúdo. Registrar no IdP a origem canônica com callbacks
`/callback`, `/callback/setup` e `/callback/fleet`. O IdP deve devolver e-mail verificado.

Para **instalação ainda sem membros**, emitir explicitamente:

```sh
bun scripts/fleet-issue-setup.ts --apply --name 'Nome da organização' --slug nome-da-org --email '<email-verificado-do-dono>' --output-dir '<diretorio-absoluto-privado-fora-do-checkout>'
```

Usar ambiente da instalação preparado pelo operador, não credenciais de outra
máquina. O comando grava `setup-code.txt`0600 em diretório próprio0700 e imprime
somente path/URL/validade. Entregar o código ao dono por canal privado, não Slack,
URL, repo ou logs. Ele abre `/setup`, informa o código e faz login real no IdP.
O token dura30min, a transação de login5min; só uma criação atômica do owner passa.
Código antigo/expirado/consumido, identidade divergente e org com membros são negados.
Reemitir antes da posse invalida tentativa anterior. Falha ao gravar o arquivo após
issuance exige reemissão em outro diretório privado; não reutilizar saída incompleta.
O comando **não** recupera org existente nem troca seu UUID.

A conclusão do bootstrap cria um papel de ID estável com atribuição explícita e
auditável das12ações de organização, ZERO concessões de projeto. O label legado
`owner` na membership não é usado pelo onboarding como autorização. Falha após
criar a política reverte também identidade, sessão e consumo do grant. Um replay
exato do recibo interno não reativa política revogada. Não há endpoint de regrant.

O guia agrupa organização → login → credenciais opcionais → instalações opcionais.
Sua conclusão registra revisão da versão exibida, não comprovação de todas as
conexões. Alterações concorrentes exigem atualizar e revisar de novo. Concluído,
o lembrete desaparece; todas as seções continuam em Configurações.

## Cofre, credenciais e transportes

Preparar Vault conforme [opção manual](../deploy/selfhost/VAULT-MANUAL.md), ou
infraestrutura de custódia aprovada pelo cliente. Só depois habilitar seus inputs
de runtime. A UI não inicializa/unseala o Vault. Se indisponível, metadata fica
visível à sessão autorizada, mas operações secretas não passam.

Em Credenciais, salvar chave SSH dedicada ou client secret OIDC. Valores vão ao
KV v2, não ao Postgres: DB contém referência lógica, revisões, estados e recibos
HMAC. API de leitura nunca devolve valor/path de cofre. Cada nova versão usa CAS0;
retries com mesma chave/payload não duplicam. Falha de DB após escrita pode deixar
versão órfã, reutilizável só pelo mesmo recibo; não há garbage collector automático.

Substituição invalida testes dependentes. Revogar impede uso futuro **no Console**,
não revoga o segredo upstream nem apaga versões/auditoria; o operador deve revogar
também no IdP/servidor quando necessário. Credencial que sustenta SSO ativo não pode
ser substituída/revogada: criar outra, testar e ativar uma nova conexão primeiro.
Imutabilidade de issuer/client impede reenviar um segredo salvo a destino arbitrário.

Instalações exigem endereço privado/Tailscale, usuário dedicado não-root e fingerprint
conferido por canal independente. Testar executa somente `ravi --version`, com IP
fixado após DNS, host key validada antes da autenticação, prazo e saída limitados.
O estado Testado expira para ativação em5min; editar config/chave invalida a prova.
Transporte ativo não é sessão de agente, gateway delegado ou autorização de usuário.

## Trocar login sem considerar um rascunho ativo

Salvar segredo vinculado a issuer/client → criar conexão candidata → entrar para
testar → revisar impacto → ativar. A prova exige PKCE/state/nonce/assinatura/e-mail
verificado do mesmo admin, sessão atual e revisões exatas. Ativação é separada e
conserva a sessão validada; revoga as outras. Identidade de outro usuário não é
apropriada. Outros membros precisam de subjects provisionados no emissor novo.

Endpoints de discovery/token/JWKS/logout devem compartilhar origem HTTPS do issuer.
IPv4 privado exige consentimento explícito; loopback/link-local/metadata/IPv6 e
redirects são bloqueados. Topologias diferentes falham fechadas, não suporte implícito.
SAML/SCIM e criação de memberships a partir de grupos não estão implementados.

A candidata usa uma lista `admissionGroups`: vazia não acrescenta restrição de
grupos; não vazia exige ao menos um nome exato do emissor. O mesmo critério vale
no teste, ativação e leitura da sessão. Configurações do candidato antigo com
`roleGroups` são recusadas: não converter automaticamente nem presumir que isso
é um upgrade já pronto para um SSO ativo. A transição exige plano de recuperação
e configuração candidata revisada pelo operador.

Config ativa é lida de DB a cada operação; segredo vem do cofre quando necessário.
Falha de DB/Vault/IdP não reativa a configuração bootstrap. Sessões existentes são
checadas contra membership/grupos atuais da configuração, sem depender da leitura
do client secret para cada página. Mudança de grupo no IdP requer novo login/revogação.

## Recuperação, rollout e rollback

Com sessão administrativa válida, corrigir a candidata ou adicionar nova conexão
testada. Se perdeu todas as sessões, recuperar primeiro o IdP/cofre/configuração
aprovada por seus custódios. Não há senha administrativa oculta, bypass web nem
bootstrap de org já ocupada. Restore é procedimento do operador autorizado.

Antes do rollout: commits conjuntos revisados, backups consistentes de Postgres e
Vault, versões/digests registrados, custódia escolhida, CA/origens/callbacks e acesso
administrativo validados. Migrations75/76 adicionam dados/coluna; não apagam tabelas
anteriores. Executar migration explicitamente uma vez sob lock; não `db:push`.

Não reverter para uma imagem que ignore SSO gerenciado depois de ativá-lo: isso
poderia reabrir o issuer bootstrap. Rollback exige imagem compatível com este
contrato/configuração ativa, ou recuperação coordenada de DB+Vault em destino novo.
Não desfazer a migration por DROP nem remover o cofre com consumidores ativos.
Backup/restore, TLS, sealed/expiry e regressão de Pages/Bases/Executor devem ser
repetidos no ambiente integrado antes de release. Somente o dono remoto da entrega
opera staging; este pacote não o alterou.

### Gates explícitos da composição local

- Entradas fixadas: onboarding5c775113, coreb4c9e117, consumidores185beb9,
  criaçãoe2c2ef5 e membros42991d54. Policies e Members usam ações independentes
  na navegação real, sem copiar worktree sujo ou ampliar grants pelo bootstrap.
- Instalações já com membros não recebem concessão por serem owner/admin. Falta
  um procedimento explícito/auditado de ativação da política para esse rollout;
  não chamar o initializer de primeira identidade nem apagar memberships.
- O DTO org settings é mínimo e separado de membros, sem arrays de compatibilidade.
  Lifecycle já provisionado foi implementado/testado; provisioning/invites e
  operação combinada membership+grant não foram implementados. Rotas legadas
  ficam negadas; nenhum owner/admin bypass permanente foi mantido nesse fluxo.
- O enum de membership e o manifesto de seed antigo são metadados/fluxos legados;
  não substituem roles UUID configuráveis da política nem inicializam grants.
- As permissões de consulta não revelam segredos. A UI de criação de conexão
  exige consulta de credenciais para selecionar uma; testes/ativação de conexão
  já conhecida continuam sujeitos à sua própria ação manage.

Veja [aceite local](ONBOARDING-ACCEPTANCE.md) para separar provas realizadas,
fixtures, limitações de build e gates de implantação.

# Implementação Ravi OSS + Console/Fleet

Autorização de Luis em 03/11/2026, na thread Ravi Operação. Branch única
`feat/oss-console-unified`; base `origin/dev`
`2650b811f98d504309837e58ac3aa27eb4fc29e1`.

Console real importado de `filipexyz/ravi-console-fleet`
`60b9ea3698aa827f7133b62eee04e7b6921dc880` em `apps/console`, apenas arquivos
versionados, sem estado, credenciais, node_modules ou builds. A origem permanece
intacta. Monorepo MIT não reúne identidades, bancos ou privilégios.

## Direção mais recente

Os adapters de canais permanecem nas instalações Ravi; o Console gerencia os
adapters através de contratos/SDK. Não criar um segundo Slack adapter no Console.
Cada conta tem um dono de conexão explícito; compartilhar atendimento não
duplica listener ou credenciais em todos os executores. Uma instalação comprometida
pode comprometer suas credenciais locais, nunca recebe autoridade administrativa
global do Console. Console e executor privilegiado exigem ambientes de confiança
separados, inclusive no modo pessoal (VM limitada ou host distinto).

Onboarding termina em **Instalação concluída → Gerenciar instalações**. Canais e
pessoas opcionais. Desktop é futuro; nenhuma conversa, app ou deep-link inventado.

## Marcos e critérios de aceite

- [x] Inspecionar origem, worktrees e alterações alheias; criar branch a partir do dev remoto.
- [x] Importar a base real Console preservando proveniência/terceiros.
- [x] Workspaces e contratos neutros com geração única reutilizada.
- [x] SDK Console com sessão humana e validação servidor, sem handlers no browser.
- [ ] Associação e identidade de instalação; transporte de saída, revogação/rotação.
- [ ] Operações duráveis, autorização atual, idempotência, recibos e retomada segura.
- [ ] Gestão dos adapters existentes, sem implementação duplicada.
- [ ] Gate Gestalt prévio, onboarding funcional, desktop/mobile/teclado.
- [ ] Testes de limites de confiança, integração, build/typecheck/lint e drift.
- [ ] Documentação de uso, commits revisáveis e relatório. Sem merge ou produção.
- [ ] Deploy obrigatório desta branch no ambiente de teste existente; registrar URL,
  revisão, saúde e jornada renderizada publicada. Aceite atualizado por Luis em
  03/11/2026; substitui a restrição anterior de nenhum deploy.

Runbooks encontrados: `staging/ui-in-place-20261102/RUNBOOK.md` e
`staging/human-bridge-test/RUNBOOK.md` no workspace orquestrador. O ambiente privado
vigente usa `/srv/fleet-human-bridge-test-20261031`; inventariar antes de operar.
Não confundir esse destino com o Compose de referência `apps/console/deploy/selfhost`.

Estudo aprovado: https://ravi-prs.ravi.page/ravi-operacao (rev4, release33).
Task de acompanhamento: task-112e6a1a; execução nesta mesma thread, sem worker duplicado.

### Prioridade atual: reset de teste autorizado

Luis pediu resetar/reinstalar e abrir para testar. O escopo é exclusivamente
`/srv/fleet-human-bridge-test-20261031`; snapshot recuperável antes do reset,
preservação dos outros containers e produção, mesma branch, sem merge. O aceite
agora inclui primeiro acesso limpo para Luis após validação publicada. Canais
compartilhados continuam como pendência independente, sem atrasar esta prioridade.

O teste de retomada identificou reutilização de certificado de outro cliente
pelo transporte TLS do Bun1.3.3 no mesmo processo. O cliente passa a usar um helper
HTTPS nativo Node, com credenciais em stdin e nenhuma autoridade humana herdada.
Sete testes PostgreSQL/TLS passaram, incluindo recuperação de recibo após revogação
humana sem repetir efeito. Removidos diagnósticos temporários antes do commit.

## Checkpoint funcional (03/11, execução em andamento)

- SDK Console: 9 operações tipadas geradas do contrato neutro. OSS e Console
  usam o mesmo gerador, com transportes/identidades distintos.
- Transporte de saída: serviço TLS em Node (Bun 1.3.3 não expõe certificado de
  cliente na API HTTPS utilizada); mTLS termina no serviço, nunca em headers.
- Migrações 0078/0079 aplicadas somente a Postgres temporário em 127.0.0.1:55439.
- Testes: 5 do diário SQLite; 4 de integração com Postgres real e servidor Node
  TLS, 32 asserts: associação, replays, recibos, onboarding, rotação, revogação.
- Interface já usa SDK; última operação é consultável após navegação. Nenhum chat.
- Ainda pendentes: validação renderizada/fluxo completo de browser, canais
  compartilhados, distribuição/instalador, build/checks finais e commits.
  Não foi feito merge, deploy nem alteração de estado em instalações reais.

React/ReactDOM fixados em 19.2.6 e Zod em 4.4.3 via Bun. Dependências residuais da importação foram removidas apenas da worktree isolada; o lockfile passa a ser único na raiz.

### Evidência de execução da jornada

`apps/console/tests/fleet/unified-browser.ts` percorreu IdP OIDC de teste real,
primeiro proprietário, confirmação por teclado, associação, SDK, teste da
instalação, recibo durável, conclusão e retorno à gestão em 1440 e 390 px.
Capturas selecionadas em `screens/` usam somente dados sintéticos. As quatro
superfícies passaram sem overflow nem violações Axe críticas/graves. As cores
de texto secundário e o nome acessível do seletor móvel foram corrigidos.

A integração Postgres/TLS tem agora 5 testes e 43 asserts, incluindo proibição de
consumir/confirmar comandos de outra instalação e serializers reais do Drizzle.
Build OSS passou; build de produção Console em validação. Nenhuma validação
utiliza credenciais, contatos, bancos ou janelas do operador.

# Proveniência e fronteira da publicação

Publicação autorizada em 23/10/2026. Snapshot sem histórico, sem alteração dos checkouts
de origem. Não é fork com histórico nem release de imagens de container.

## Código

- Console: `96bb3be745568569f4096ef0f0717cec17ff00ad`.
  Exportação dos diretórios `src`, `workers`, `drizzle`, `scripts`, package/lock,
  configurações de build e Dockerfiles. Código, migrations e testes preservados byte a byte,
  exceto a exclusão do manifesto local `src/apps/console/control/ravi.app.json`, que
  continha comandos com caminho absoluto de um checkout particular.
- `.env.example` substituído por placeholders vazios OIDC; `.gitignore`/`.dockerignore`
  reforçados. README/AGENTS e docs desta publicação são novos, não copiados da operação.
- Executor upstream: https://github.com/UsefulSoftwareCo/executor,
  base `4998ad02128bc99b4861adea67377a54b2b6ef1d`, integração
  `fce0f24dbb2226a0735e9e0a860d3f309f3e979f`.
  Exportado como patch de um commit, sem árvore `.selfhost-runtime` ou estado de execução.
- Compose, Caddy, inicialização Postgres, geração de segredos e complemento de
  configuração foram copiados da referência local de staging. Domínios `.test` são
  placeholders privados; não é um dump da configuração ativa de um cliente.

## Licenças

A descrição original de 23/10/2026 registrava o Console como proprietário.
Em 03/11/2026 Luis autorizou sua integração, junto ao Fleet, ao Ravi OSS sob MIT.
Esta árvore integrada usa a licença MIT da raiz. Licenças e atribuições de terceiros
continuam preservadas; o snapshot de origem e seu histórico não foram alterados.
Executor permanece MIT; licença integral em `integrations/executor/LICENSE`, copyright
2026 Rhys Sullivan. Dependências mantêm suas próprias licenças, identificadas pelo lockfile.

`deploy/selfhost/chromium-seccomp.json` deriva do perfil Moby (Apache-2.0), commit
`4b8214fc4971e06172938a1f1554ccff6647ee80`,
https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json.
Modificação local: regra adicional para clone/setns/unshare/chroot necessária ao sandbox
Chromium; clone3 mantém fallback ENOSYS. Licença integral em `deploy/selfhost/LICENSE.moby`.
Não se habilitam `SYS_ADMIN`, modo privilegiado, seccomp unconfined ou `--no-sandbox`.

## Exclusões deliberadas

Histórico `.git`; `.ravi`; notas e memórias; AGENTS/CLAUDE originais; sites e conteúdo
publicado; envs reais; chaves; contas; certificados gerados; bancos/dumps/volumes;
backups; screenshots; traces/logs; relatórios brutos; arquivos temporários; node_modules;
artefatos de build; manifests Cloudflare/Vercel; scripts operacionais de SSH/deploy;
configuração do Ravi pessoal e credenciais do Mac; Slack; enrollment Tailscale;
tokens de provider. O gerador de segredos é código-fonte, não saída de sua execução.

Fixtures sintéticas de testes de criptografia/redação permanecem como testes, não como
credenciais de instalação. O relatório de publicação lista seus fingerprints revisados;
não há exclusão genérica de todos os testes no scanner.

# Ravi Console Fleet

Base privada para o Console single tenant e a futura comunicação com instalações Ravi.
Uma instalação do Console representa uma organização/cliente. O agente roda na
instalação Ravi; o Console não deve hospedar outro motor de agente.

## O que está neste snapshot

- Console Next/Node com OIDC, sessão e autorização locais; uma organização técnica fixa.
- Pages self-hosted em Bun: publicação/releases, páginas privadas, Bases e operações
  delegadas ao Console pelo Executor, com identidade e idempotência.
- Motor IA do Pages desabilitado na configuração da instalação e bloqueado por guards.
  Código compartilhado/dependências antigas continuam presentes, inativos; não houve expurgo físico.
- Referência Compose de staging: Postgres, Keycloak de teste, S3 compatível,
  Console, Pages, Executor e Caddy; segredos são gerados localmente, não publicados.
- Patch da integração Executor sobre um commit upstream exato, com licença MIT.

## O que ainda não está implementado

O **bridge Console → instalações Ravi** é proposta: não há transporte SSH provisionado,
troca de identidade SSO nem chat de frota implementado por esta publicação.
Ver [proposta e invariantes](docs/FLEET-BRIDGE.md).
Slack foi retirado desse caminho. Mail, conectores/MCP e serviços comerciais centrais
não são serviços ativos deste Compose, embora código legado permaneça no snapshot.

## Começar

1. Leia [proveniência e exclusões](docs/PROVENANCE.md).
2. Prepare um ambiente vazio com [a referência de instalação](deploy/selfhost/README.md).
3. Reaplique o [patch do Executor](integrations/executor/README.md).
4. Valide sua instalação; [os testes históricos](docs/STATUS.md) não substituem isso.

Não execute os scripts legados `*:worker:deploy`, `deploy:build` ou `db:push` para instalar
esta referência. O `package.json` e lockfile do produto foram preservados; os manifests
Cloudflare/Vercel e o Compose antigo não foram publicados. Não há workflow de CI/CD;
GitHub Actions foi desabilitado antes do primeiro push.

Este repositório começa com **um commit raiz novo**, sem o histórico do Console.
Nenhum segredo, backup, banco, evidência operacional bruta ou arquivo pessoal acompanha
o snapshot. Publicar o código não altera o staging existente e não homologa produção.

# Referência reproduzível de staging

Onboarding administrativo novo: [contrato e runbook](../../docs/ONBOARDING.md).
O [overlay Vault manual](VAULT-MANUAL.md) é opcional e exige decisão de custódia;
não é habilitado por este Compose. Para primeiro dono novo, usar o fluxo one-time
documentado, não confundir com o bootstrap de fixtures sintéticas abaixo.

Este diretório contém **inputs**, não uma instalação nem dados de uma instalação.
Nenhum comando deste runbook foi executado para publicar o repositório. Prepare somente
um ambiente vazio e autorizado; não aplique sobre volumes/serviços existentes.

## Pré-requisitos e limites

Linux amd64, Docker/Compose, Bun e OpenSSL; capacidade de staging de referência 4 vCPU/
16 GiB. Isso não é dimensionamento de produção. Builds devem ser sequenciais e podem
exigir mais memória que os serviços em idle. Não há instalação de pacotes ou Terraform aqui.

Domínios canônicos `console`, `idp`, `s3`, `executor` e `*.pages.nba-console.test` são
privados de teste, não DNS público. Console tem origem fixada no Dockerfile: mudar domínio
exige alinhar build, ambiente, certificados, Caddy, callbacks OIDC e resolução de nomes.
Não use `.localhost` entre containers: Bun pode resolver para o próprio loopback.

## 1. Construir as imagens

Na raiz do monorepo Ravi para a imagem Console (a imagem Pages ainda usa o contexto apps/console), sem envs reais no contexto Docker:

```sh
docker build --platform linux/amd64 -f apps/console/Dockerfile --build-arg CONSOLE_ORIGIN=https://console.nba-console.test -t ravi-console-fleet/console:snapshot .
docker build --platform linux/amd64 --build-arg BUN_IMAGE=oven/bun@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e -f workers/pages/Dockerfile -t ravi-console-fleet/pages:snapshot .
```

Construa Executor seguindo `integrations/executor/README.md`. Imagens de aplicação não
foram enviadas a registry: tags do exemplo são locais; digests históricos não são URLs
de download. Registre os IDs/digests realmente construídos. Bases de infraestrutura
estão fixadas em `images.env.example`; apt/browser downloads ainda dependem de fontes
externas, portanto não se promete build bit a bit reproduzível.

## 2. Preparar configuração nova, fora do checkout

Layout esperado, com `config` contendo os arquivos deste diretório:

```text
<novo-root-privado>/
  config/   compose.yaml, Caddyfile, postgres-init.sh, chromium-seccomp.json, images.env
  secrets/  *.env, realm.json, bootstrap.json, tls/
  data/     postgres/, keycloak/, s3/, pages/, executor/
  backups/  inicialmente vazio
```

Copie `images.env.example` como `images.env` nesse diretório privado. Copie também os dois
geradores para `config` e execute, conscientemente, no ambiente novo:

```sh
bun prepare-secrets.ts
bun complete-runtime-config.ts
```

Eles criam `config/.private` com segredos aleatórios, IdP/contas **sintéticos** e CA/leaf
de 7 dias. Recusam regeneração sobre diretório existente. Não usam credenciais do Mac
nem chave de provider. Copie para `secrets` somente envs, realm/bootstrap e certificados
necessários; mantenha `test-accounts.json` e a chave **privada da CA** em armazenamento
administrativo seguro, fora de mounts de aplicação. Não imprima esses arquivos.

Ajuste ownership dos volumes no host: postgres `999:999`, Keycloak `1000:0`, S3
`10003:10003`, Pages `10001:10001`, Executor `65532:65532`. Diretórios privados devem
ser `0700`. Env files/realm/bootstrap/chaves não devem ser world-readable; dê leitura
somente ao processo necessário: realm UID1000, bootstrap UID10000, server.key UID10002.
Certificados **públicos** CA/leaf podem ser `0644`; não confundir certificado com chave.
Não copie CA.key para containers nem altere confiança global do sistema.

## 3. Inicializar, explicitamente

No diretório privado `config`, os comandos abaixo são para instalação **vazia**:

```sh
docker compose --env-file images.env -f compose.yaml up -d postgres keycloak s3 proxy
docker compose --env-file images.env -f compose.yaml --profile apps run --rm --no-deps --entrypoint bun console scripts/migrate-with-lock.ts
docker compose --env-file images.env -f compose.yaml --profile apps run --rm --no-deps --entrypoint node console node_modules/@workflow/world-postgres/bin/setup.js
```

Faça o bootstrap com `scripts/bootstrap-single-tenant.ts`, `RAVI_SINGLE_TENANT_BOOTSTRAP=true`
e mount read-only do `secrets/bootstrap.json` em `/run/bootstrap.json`, legível pelo UID10000.
O script exige OIDC/DATABASE_URL explícitos, recusa outra organização e não reassocia
identidades existentes. Depois:

```sh
docker compose --env-file images.env -f compose.yaml --profile apps up -d console pages executor
```

Postgres inicializa roles/databases separados. Migrations são operações explícitas, não
efeito colateral de startup. Não use `db:push` nem execute bootstrap contra dados de cliente.
O import Keycloak usa `emailVerified=true` somente para fixtures `@staging.invalid`;
isso não valida e-mails reais nem substitui provisionamento corporativo.

## 4. Acessar e validar

Caddy publica **somente 127.0.0.1:443**. De outro computador, use transporte privado
autorizado com host key verificada; não há chave SSH, túnel ou Tailscale configurado por
este pacote. Preserve SNI/Host canônico e confie na CA apenas no cliente de teste, com
resolução explícita desses domínios. Não use TLS inseguro para contornar configuração.

Valide login/negativas/logout, publicação privada, Bases leitura/escrita/retry, operações
via Executor, auditoria/idempotência, UI desktop/mobile e IA indisponível. Depois teste
restart, backup consistente, restore em volumes novos e upgrade/rollback de imagens
distintas. O perfil Compose normal permite saída: não representa restore isolado sem egress.
Crie uma topologia de restore separada, auditada, antes desse teste.

Nenhum script de backup/restore operacional, volume ou prova bruta foi exportado.
RPO/RTO, backup externo, licença central, IdP real e política de atualização continuam
decisões de implantação. Nunca use `down -v`, prune ou restaure sobre a instalação ativa.

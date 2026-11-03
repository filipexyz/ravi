# Uso da distribuição unificada

Este é o código da branch `feat/oss-console-unified`. Console/API e Ravi são
artefatos do mesmo monorepo, executados em ambientes de confiança diferentes.

## Construir

```sh
bun install --frozen-lockfile
bun run build
bun run console:sdk:check
docker build -f apps/console/Dockerfile --build-arg CONSOLE_ORIGIN=https://console.example -t ravi-console:review .
docker build -f Dockerfile.runtime -t ravi-runtime:review .
```

Registre os IDs imutáveis das duas imagens e o commit. O runtime precisa de Bun e
Node 24: o helper Node evita reutilização indevida de certificado observada na
API TLS do Bun 1.3.3. Os handlers, adapters e providers continuam no runtime Bun.

## Console novo

Execute no ambiente dedicado ao Console, como usuário de serviço sem root.
Configure primeiro PostgreSQL/HTTPS/OIDC conforme a infraestrutura escolhida.
O preparador inclui PostgreSQL, API e transporte; usa o IdP HTTPS escolhido pelo
operador. O proxy TLS deve apontar para a API loopback3000 e encaminhar TCP7443 ao
transporte sem terminar o mTLS. Não abra banco, containers ou Docker publicamente.

Crie um JSON do operador, fora do checkout, com modo0600:

```json
{
  "directory": "/srv/ravi-console/new-installation",
  "image": "sha256:ID_IMUTAVEL_DA_IMAGEM",
  "consoleOrigin": "https://console.example",
  "transportOrigin": "https://fleet.example:7443",
  "oidcIssuer": "https://idp.example/realms/ravi",
  "oidcClientId": "ravi-console",
  "oidcSecretFile": "/srv/operator/oidc-secret",
  "ownerEmail": "operador@example.com",
  "organizationName": "Minha operação",
  "slug": "minha-operacao"
}
```

```sh
bun run console:install --config /srv/operator/config.json
bun run console:install --config /srv/operator/config.json --execute
```

O primeiro comando mostra o plano. O segundo recusa diretório existente, cria
chaves/estado privados, sobe o banco, aplica migrations e emite primeiro acesso.
`--execute --prepare-only` gera os arquivos para um operador aplicar um perfil
de implantação existente, sem iniciar serviços. `setup/setup-link.txt` é privado;
abra seu conteúdo no browser, não publique o link com prova em um canal.
O código manual fica como fallback. Nenhum executor é instalado no Console.

## Conectar o Ravi

Em outra máquina/VM, instale o runtime e suas dependências pelo setup existente:

```sh
ravi console connect --url https://console.example
```

Confirme a instalação no browser autenticado. Para servidor sem browser use
`--no-open`, abrindo o link na máquina do operador. O daemon detecta a associação
e estabelece saída automaticamente. Sem daemon, `ravi console run` mantém a
conexão em primeiro plano. Verifique a instalação na interface e conclua.

## Canais e limites atuais

Em Gerenciar instalações, expanda Configurar canais, consulte conexões existentes
no cofre nativo do Ravi e escolha a conta. O Console reserva o dono do bot e
enfileira a configuração; a instalação verifica a identidade no Slack, usa o
adapter existente e devolve recibo. Tokens não passam pelo browser.

Ainda falta a distribuição central de credenciais e o roteamento de eventos de
um dono para outras instalações. Não confundir a configuração funcional com
atendimento compartilhado já entregue. A investigação/implementação continua
na mesma branch após o reset de teste solicitado por Luis.

O ambiente privado de teste usa containers sem mounts do host ou socket Docker;
isso limita o teste, mas não comprova isolamento de kernel/host entre Console e
executor. Para runtime com acesso total à máquina, use host ou VM separados.

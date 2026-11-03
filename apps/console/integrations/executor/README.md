# Integração Executor

Upstream: https://github.com/UsefulSoftwareCo/executor (MIT, licença integral ao lado).
Base exata: `4998ad02128bc99b4861adea67377a54b2b6ef1d`.
Commit integrado de origem: `fce0f24dbb2226a0735e9e0a860d3f309f3e979f`.

Em checkout **novo**, separado, autorizado para build:

```sh
git clone https://github.com/UsefulSoftwareCo/executor.git executor-build
cd executor-build
git checkout --detach 4998ad02128bc99b4861adea67377a54b2b6ef1d
git apply --check /absolute/path/ravi-console-fleet/integrations/executor/0001-feat-support-external-OIDC-authority-and-signed-dele.patch
git apply /absolute/path/ravi-console-fleet/integrations/executor/0001-feat-support-external-OIDC-authority-and-signed-dele.patch
docker build --platform linux/amd64 -f apps/host-selfhost/Dockerfile -t ravi-console-fleet/executor:snapshot .
```

O patch preserva o app/UI Executor e acrescenta OIDC externo, autoridade Console,
delegação assinada e callbacks. Não inclui segredos, banco libSQL ou `.selfhost-runtime`.
O build usa os digests do Dockerfile do commit, não a imagem privada do staging.
Aplicar o patch não substitui testes de integração com a sua autoridade/IdP.

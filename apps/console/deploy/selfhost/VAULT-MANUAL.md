# Vault manual — opção local, implantação ainda gated

Este pacote **não escolhe a custódia real**, não inicializa/desbloqueia um cofre,
não guarda shares/root token e não liga serviços automaticamente. O cliente ainda
deve escolher custódios/unseal manual ou seu KMS/HSM, release/digest suportado,
certificados, retenção, renovação do token e recuperação. Sem isso, não implantar.

## Arquivos e limites

`vault-manual.compose.yaml` é um overlay opcional de `compose.yaml`; usa Vault
single-node Raft, usuário dedicado, TLS, armazenamento persistente, sem portas no
host e rede interna só para Console/cofre. Não é HA/DR nem dimensionamento de
produção. Não altera Pages/Executor, DNS, SSH ou a instalação Ravi. Não substitui
seu broker: a versão Ravi estudada recebe VAULT_TOKEN de ambiente; a ponte desse
broker e sua renovação continuam separadas, não fingimos suporte token-file lá.

`VAULT_IMAGE` deve ser uma imagem oficial aprovada por digest SHA256, não `latest`.
O valor é deliberadamente obrigatório e não fornecido por esta opção. Antes de
executar, confira digest/plataforma/UID, `docker compose ... config`, mounts e
limites efetivos. Os testes locais do adaptador usaram Vault 1.21.0 em processos
isolados/file e Raft, com restore quiescente: **não validam este overlay/container
em execução, live snapshot ou DR externo**.

Copiar estes templates para o `config/` de um root privado NOVO e autorizado.
Preparar separadamente, sem secrets no checkout:

| Entrada | Propriedade exigida |
| --- | --- |
| `secrets/vault-tls/` | somente CA pública, leaf SAN `vault`, chave servidor; UID10004, dir0700/key0400 |
| `data/vault/`, `data/vault-audit/` | UID10004:10004,0700; sem shares/root token |
| `secrets/fleet-vault-client/` | UID10000:10000,0700; somente `token`,0400 ou0600 |
| `secrets/fleet-vault-ca/ca-bundle.pem` | apenas CAs públicas necessárias ao Console, incluindo o IdP e Vault; sem chaves |

Volumes longos recusam paths inexistentes. TLS permanece verificado; não usar
skip-verify. UID do token deve ser root ou o consumidor, sem acesso de grupo/outros.
O diretório montado permite trocar o token atomicamente; o adaptador relê a cada
operação. Nunca colocar token em YAML/env/argv/URL, retornar pela API ou imprimir.
Mantemos `disable_mlock=true` para Raft, sem swap do container e sem core dump;
o operador deve validar a aplicação desses limites no host, sem inferir isso do
YAML. [Referência Raft](https://developer.hashicorp.com/vault/docs/configuration/storage/raft).

Comando abaixo somente APÓS aprovar inputs/custódia, em instalação nova:

```sh
docker compose --env-file images.env -f compose.yaml -f vault-manual.compose.yaml --profile vault-manual config --quiet
docker compose --env-file images.env -f compose.yaml -f vault-manual.compose.yaml --profile vault-manual up -d vault
```

Não iniciar/recriar o Console até o plano de implantação conjunta ser aprovado.
Não há dependência de health do cofre para subir a UI: metadata administrativa
permanece acessível com sessão válida; operações que exigem segredo falham fechadas.
Um cofre sealed nunca produz “conexão validada” nem fallback para outro IdP.

## Inicialização e operação sob custódia do cliente

Custódios operam pela interface administrativa privada autenticada, fora do
Console/agente. Conferir TLS, storage vazio e status antes de **uma** inicialização.
Definir quorum e destinatários; a API oficial aceita PGP para criptografar shares
e root token diretamente aos custódios. Este pacote não captura nem persiste a
resposta de init. Unseal deve ocorrer por prompt/canal privado; nunca shares em
argv, logs ou ao lado dos dados. Após reinício, unseal manual volta a ser necessário.
[Inicialização](https://developer.hashicorp.com/vault/api-docs/system/init),
[seal/unseal](https://developer.hashicorp.com/vault/docs/concepts/seal).

O administrador do cofre deve habilitar KV v2 em `console-fleet`, configurar audit
HMAC (por exemplo em `/vault/audit/`), substituir o UUID na policy exemplo e emitir
credencial de aplicação **sem root/default amplo**, com TTL/custódia/rotação
definidos. A policy só permite KV do UUID desta instalação, não administração.
Depois configurar um caminho administrativo recuperável e revogar o root inicial.
Não deixamos root token permanente no app. Auditar/rotacionar logs sem expor valores.
[Hardening oficial](https://developer.hashicorp.com/vault/docs/concepts/production-hardening).

Esta versão do Console não renova token automaticamente. O operador deve instalar
outro token escopado antes do vencimento, por substituição atômica do arquivo no
diretório já montado, validar uso e revogar o anterior. Nunca manter TTL infinito
para esconder a falta de renovação. Um agente Vault/token sink pode ser outra
opção futura, mas não está provisionado/testado por este template.

## Recuperação e gate de implantação

Backup coordenado inclui Postgres (refs/estado), snapshot Raft e versões/config
para a mesma janela consistente. Não copiar Raft vivo como se fosse snapshot.
Shares ficam com custódios externos; app tokens/sessões no backup exigem proteção
e reemissão/revogação no restore. Snapshot sozinho não substitui unseal nem DR.
Restaurar somente em root/rede novos sem egress, verificar TLS, unseal, acesso KV
por org, referências, rotação e falhas; não testar sobre o cofre ativo.

Antes do deploy: validar restore Raft real, token expiry/replacement, boot sealed,
log redaction e negativos de API no build conjunto com permissões. Falta de token,
cofre sealed, ACL errada ou CA inválida deve dar erro sanitizado; login gerenciado
não pode usar configuração bootstrap como fallback. Retirar overlay só é rollback
seguro se não há SSO ativo dependente dele; caso contrário, manter serviço/dados e
recuar para imagem compatível, sem apagar tables/segredos. Nunca `down -v`/prune.

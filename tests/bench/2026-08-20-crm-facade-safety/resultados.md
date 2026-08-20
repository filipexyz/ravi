# Resultados da correcao de seguranca da facade CRM

## Veredito

`PASS` para implementacao e producao. O bundle global ativo na VPS corresponde
ao commit de runtime `aa660cc7` e fechou os bloqueadores de visibilidade,
defaults opcionais, autoridade de planejamento, eventos e cobertura por
operacao.

## Artefato

- Pacote Linux promovido: `ravi.bot-3.260817.2-aa660cc-linux.tgz`.
- SHA-256 do pacote: `0b78f8da9d690223e1317eb76f4ba7e7b44731e4c8ffeef7c6fe32edb67c2992`.
- SHA-256 do bundle candidato e ativo:
  `4d90c2c66de9b4bd1a2b2dda8e0cd30300898e9b4516db98284922776e963004`.
- Versao publicada pelo CLI: `3.260817.2`.

## Validacao local

- Facade: `48 pass`.
- CLI CRM: `41 pass`.
- Integracao do modelo de identidade: `44 pass`.
- Contrato do SDK CRM: `3 pass`.
- Approval service: `6 pass`.
- SDK completo: `76 pass` e zero drift.
- Quality Gate: `40 pass`.
- Build, typecheck, agent-contract, OpenAPI e Swift drift check: `PASS`.
- `swift test` ficou a cargo do CI porque o toolchain nao existe no host
  Windows local.

## E2E na VPS

O candidato e o binario global foram testados com bancos descartaveis. Nenhum
registro CRM real foi mutado pelos smokes de deploy.

- ST12 `CRM_FACT_NOT_FOUND`: `PASS`.
- ST13 `CRM_TASK_NOT_FOUND`: `PASS`.
- ST14 `OPPORTUNITY_NOT_FOUND` sem sugestoes amplas: `PASS`.
- Criacao, conclusao e readback de task descartavel: `PASS`.
- `facade plan task.done`: `PASS`.
- `verify` antes do efeito retorna `not_applied`: `PASS`.
- `recover` retorna `replay:false`: `PASS`.
- Readback da facade omite agregados nao relacionados: `PASS`.

## Readback de producao

- `ravi crm task list --limit 1 --json` retornou uma pagina valida sobre 743
  tasks.
- `ravi crm help --json` publica `facade plan` com `mutates:true`.
- `ravi crm lifecycle show --json` publica `enforcement:"facade-only"`.

## Rollback

- Pacote anterior:
  `/home/ravi/.ravi/backups/ravi.bot-3.260817.2-pre-aa660cc.tgz`.
- SHA-256 do pacote anterior:
  `422bec1fb3b3f985f950586a5cc5ece2d2d1f4949f570ffada8896f18729b8be`.
- Backup online do SQLite:
  `/home/ravi/.ravi/backups/ravi.db-pre-aa660cc.sqlite`.
- SHA-256 do banco:
  `61718344a3d4bbfb12ab5f24a4289de46a8732f4f7b8430ad6298dea8ec18a2c`.

O rollback reinstala o pacote anterior, confirma seu hash e executa apenas
readbacks. O banco deve ser restaurado somente se houver evidencia de corrupcao
ou migracao incompativel; as tabelas aditivas da facade podem permanecer
inertes.

## Limite de rollout

Os comandos legados continuam disponiveis. A substituicao global do binario
entrega a facade corrigida, mas a migracao de cada consumidor para
`plan -> approve -> apply -> verify` continua sendo feita por operacao.

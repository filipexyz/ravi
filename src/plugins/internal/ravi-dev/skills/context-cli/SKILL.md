---
name: context-cli
description: |
  Ensina como emitir contexto-filho e integrar CLIs externos com o runtime do Ravi. Use quando precisar:
  - Criar ou revisar um generator/launcher para CLI externa
  - Ensinar um agent a emitir `ravi context issue` com least privilege
  - Validar o contrato de `RAVI_CONTEXT_KEY`, identidade e approvals
  - Auditar lineage de contextos emitidos para CLIs
---

# Context CLI - Teaching Layer

Use esta skill quando o trabalho envolver um CLI externo rodando "dentro" de um contexto do Ravi.

Ela existe para evitar dois erros recorrentes:

1. tentar reconstruir identidade com `RAVI_AGENT_ID` / `RAVI_SESSION_KEY`,
2. tratar approval como algo fora do contexto emitido.

## Regra Principal

Para CLIs externos, `RAVI_CONTEXT_KEY` e o comando `ravi context ...` sao a interface canonica.

Nao ensine o agent a:

- injetar `RAVI_AGENT_ID`
- injetar `RAVI_SESSION_KEY`
- injetar `RAVI_SESSION_NAME`
- inferir identidade pelo nome da sessao

Ensine o agent a:

- emitir contexto-filho com `ravi context issue`
- passar `RAVI_CONTEXT_KEY` para o processo filho
- resolver identidade com `ravi context whoami`
- checar capacidade com `ravi context check`
- pedir approval com `ravi context authorize`
- auditar/inspecionar com `ravi context list/info/revoke`

## Fluxo Canonico

### 1. Emitir contexto-filho

```bash
ravi context issue meu-cli --allow execute:group:daemon --ttl 1h
```

Boas praticas:

- `cliName` estavel e sem ambiguidade
- capabilities explicitas por default
- `--inherit` so quando houver razao real
- TTL curto por default

### 2. Passar o contexto para o processo externo

O launcher/generator deve repassar:

```bash
RAVI_CONTEXT_KEY=<emitido pelo issue>
```

Pode herdar o resto do ambiente normal do processo, mas nao deve sintetizar identidade do Ravi via outras variaveis.

### 3. Resolver identidade dentro do CLI externo

```bash
ravi context whoami
```

Campos importantes:

- `contextId`
- `kind`
- `agentId`
- `sessionKey`
- `sessionName`
- `source`
- `metadata`
- `capabilitiesCount`

### 4. Checar ou pedir capability

Dry-check:

```bash
ravi context check execute group daemon
```

Approval:

```bash
ravi context authorize execute group daemon
```

Interpretacao correta:

- `allowed=true, inherited=true` -> ja tinha capability
- `allowed=true, approved=true` -> approval novo anexado ao contexto atual
- `allowed=false` -> negar/timeout; respeitar `reason`

### 5. Executar a acao real

```bash
ravi daemon status
```

## Lineage e Auditoria

Ao ensinar agentes a usar contexto-filho, enfatize:

- `ravi context list` para visao geral sem expor `contextKey`
- `ravi context info <contextId>` para lineage detalhado
- `ravi context revoke <contextId>` para encerrar contexto emitido

Lineage esperado no metadata:

- `parentContextId`
- `parentContextKind`
- `issuedFor`
- `issuedAt`
- `issuanceMode`
- `approvalSource` (quando herdado)

## Checklist de Ensino

Quando o usuario pedir um "CLI externo integrado ao Ravi", ensine nesta ordem:

1. Qual capability minima o CLI realmente precisa?
2. Qual `cliName` vai entrar no audit trail?
3. O launcher ja usa `ravi context issue`?
4. O processo filho recebe so `RAVI_CONTEXT_KEY` como credencial Ravi?
5. O CLI chama `whoami/check/authorize` antes da acao?
6. O fluxo de suporte sabe usar `list/info/revoke`?

## Artefatos de Referencia

- Contrato formal: `docs/context-generator-contract.md`
- Referencia minima: `src/reference/context-cli.ts`
- Comandos CLI: `src/cli/commands/context.ts`
- Registry/runtime: `src/runtime/context-registry.ts`

## Sinais de Implementacao Ruim

Pare e corrija se encontrar:

- testes/setups exportando `RAVI_AGENT_ID` para "simular" contexto
- launchers que pulam `ravi context issue`
- CLIs que executam a acao real sem `check`/`authorize`
- logs ou comandos que imprimem `contextKey`
- audit trail sem `cliName` estavel

## Exemplo Minimo

```bash
# sessao Ravi pai
ravi context issue ext-cli --allow execute:group:daemon

# processo filho
ravi context whoami
ravi context authorize execute group daemon
ravi daemon status
```

## Resultado Esperado

Ao aplicar esta skill, o agent deve conseguir:

- emitir contexto-filho com least privilege
- explicar por que `RAVI_CONTEXT_KEY` basta
- integrar um CLI externo sem spoofing de identidade
- auditar lineage e lifecycle do contexto emitido

# Context Key

Use esta referencia quando o CLI rodar dentro do runtime do Ravi.

## Regra Principal

Para CLIs externos, a interface canonica e:

- `ravi context issue`
- `RAVI_CONTEXT_KEY`
- `ravi context whoami`
- `ravi context check`
- `ravi context authorize`

Nao use:

- `RAVI_AGENT_ID`
- `RAVI_SESSION_KEY`
- `RAVI_SESSION_NAME`

## Fluxo Canonico

### 1. Processo pai emite contexto-filho

```bash
ravi context issue meu-cli --allow execute:group:daemon --ttl 1h
```

Boas praticas:

- `cliName` estavel
- capability minima necessaria
- TTL curto por default
- `--inherit` so com motivo claro

### 2. Processo filho recebe apenas a key

```bash
RAVI_CONTEXT_KEY=<valor emitido>
```

Essa e a unica credencial Ravi que o processo filho precisa.

### 3. CLI resolve identidade

```bash
ravi context whoami
```

Campos importantes:

- `contextId`
- `agentId`
- `sessionKey`
- `sessionName`
- `source`
- `metadata`

### 4. CLI valida e pede approval

```bash
ravi context check execute group daemon
ravi context authorize execute group daemon
```

Interpretacao correta:

- `allowed=true, inherited=true` -> capability herdada
- `allowed=true, approved=true` -> approval novo concedido
- `allowed=false` -> negado, timeout ou fora da policy

## Lineage e Auditoria

O CLI deve permitir ou ensinar suporte a usar:

- `ravi context list`
- `ravi context info <contextId>`
- `ravi context revoke <contextId>`

Lineage esperado:

- `parentContextId`
- `parentContextKind`
- `issuedFor`
- `issuedAt`
- `issuanceMode`

## Sinais de Implementacao Ruim

Pare e corrija se encontrar:

- export de ids de sessao para "simular" contexto
- CLI executando a acao real sem `check`/`authorize`
- logs imprimindo `contextKey`
- launcher pulando `ravi context issue`

## Resultado Esperado

O CLI deve conseguir operar com least privilege, identidade correta e audit trail completo usando apenas `RAVI_CONTEXT_KEY`.

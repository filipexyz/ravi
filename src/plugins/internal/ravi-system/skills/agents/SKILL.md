---
name: agents-manager
description: |
  Gerencia agents do sistema Ravi. Use quando o usuário quiser:
  - Criar, admitir, inspecionar, configurar ou deletar agents
  - Escolher provider, modelo direto ou runtime model preset
  - Autorizar skills e capabilities pelo contrato de least privilege
  - Validar continuidade, rotas, sessões e entrega por trace
  - Configurar effort, debounce, modo ou execução remota
---

# Agents Manager

Agents são identidades operacionais persistidas no Ravi. Cadastro não significa
admissão: um agent só está pronto quando instruções, skills, permissões, runtime
efetivo e entrada operacional correspondem ao papel aprovado.

O contrato normativo é `.ravi/specs/agents/admission`.

## Invariantes

- Defina papel, fronteiras e necessidades antes de conceder autoridade ou rota.
- `AGENTS.md` instrui o agent, mas não autoriza skill, tool, CLI ou provider.
- Skills customizadas exigem grant explícito. Skills de sistema derivam das
  capabilities efetivas; grant manual não substitui permissão.
- Permissões seguem least privilege e devem ser provadas por `materialize`.
  `full-access` não é default de criação.
- Provider/model persistidos não bastam quando há política de continuidade:
  valide o alvo efetivo com `show` e `explain`.
- Agent conversacional exige readback da rota e smoke controlado. Agent interno
  exige evidência equivalente de execução controlada.
- Não use reset, restart, delete ou permissão ampla para mascarar divergência.
- Antes de operar, leia `ravi agents --help` e o contrato de cada tool
  necessária com `ravi tools show <tool>`.

## Fluxo de admissão

### 1. Definir manifesto e workspace

Escolha um `id` estável e um `cwd` próprio. Escreva o `AGENTS.md` canônico antes
de colocar o agent em rota.

Estrutura mínima:

```markdown
# <Nome>

## Papel
- Responsabilidade e objetivo

## Contexto
- Dados, sistemas e canais disponíveis

## Necessidades
- Skills customizadas
- Capabilities mínimas
- Provider/model ou preset aprovado

## Limites
- Ações proibidas, aprovações e escalonamento
```

O manifesto de necessidades é input para a admissão, não prova de autorização.

### 2. Criar com runtime aprovado

Prefira um model preset quando a política de runtime for reutilizável:

```bash
ravi runtime presets list --json
ravi runtime presets show <preset-id> --json
ravi agents create <agent-id> <cwd> \
  --model-preset <preset-id> \
  --json
```

Para um binding exclusivo:

```bash
ravi agents create <agent-id> <cwd> \
  --provider <provider-id> \
  --model <model-selector> \
  --json
```

`--model` e `--model-preset` são mutuamente exclusivos. Se `--provider` for
usado com preset, ele deve coincidir com o provider do preset. Não use
`--allow-runtime-mismatch` sem diagnóstico explícito da diferença entre o CLI e
o runtime live.

Leia de volta o cadastro:

```bash
ravi agents show <agent-id> --json
```

Confira ao menos `cwd`, provider/model ou preset persistidos e a resolução
retornada. Não conclua o runtime efetivo apenas pelo campo `model`.

### 3. Autorizar skills

Primeiro inspecione a allowlist resolvida:

```bash
ravi skills inspect <agent-id> --json
```

Para cada skill customizada necessária:

```bash
ravi skills grant <agent-id> <skill-name> \
  --note "<necessidade aprovada>" \
  --json
ravi skills inspect <agent-id> --json
```

O segundo `inspect` deve mostrar a skill e sua proveniência em
`provenance.fromGrants`. Para skill de sistema, não use `skills grant`: conceda
a capability mínima correspondente e confirme a skill em
`provenance.fromCapabilities`.

### 4. Planejar, aplicar e provar permissões

Leia primeiro a autoridade materializada:

```bash
ravi permissions materialize \
  --subject-type agent \
  --subject-id <agent-id> \
  --json
```

Quando faltar um profile/tag, gere um plano estreito:

```bash
ravi permissions allow <profile> \
  --to agent:<agent-id> \
  --agent <agent-id> \
  --capabilities <capability-1>,<capability-2> \
  --json
```

`permissions allow` é dry-run por padrão. Revise o plano e obtenha a aprovação
exigida antes de aplicar:

```bash
ravi permissions allow <profile> \
  --to agent:<agent-id> \
  --agent <agent-id> \
  --capabilities <capability-1>,<capability-2> \
  --apply \
  --json

ravi permissions materialize \
  --subject-type agent \
  --subject-id <agent-id> \
  --json
```

O readback deve conter apenas as capabilities necessárias. Em fluxo iniciado
por contato ou automação, valide separadamente a autoridade do ator; o teto do
executor agent não concede autoridade ao chamador.

### 5. Validar continuidade e runtime efetivo

Consulte a política e a elegibilidade sem iniciar provider call:

```bash
ravi runtime continuity show <agent-id> --json
ravi runtime continuity explain <agent-id> --json
```

Essas leituras não habilitam continuidade. Compare a ordem de targets elegíveis
com o provider/model ou preset aprovado. Configuração de cadastro e estado
efetivo de continuidade são camadas diferentes.

Não declare failover funcional a partir de configuração. Isso exige que o mesmo
logical request registre a troca de target e uma única entrega terminal
observada.

### 6. Criar e ler de volta a rota

Para canal externo já aprovado, crie a rota pela superfície da instância:

```bash
ravi instances routes add <instance> <pattern> <agent-id>
ravi instances routes show <instance> <pattern> --json
```

O readback deve apontar para o agent esperado. Aprovação de contato, criação de
grupo e política de resposta pertencem às skills específicas do canal; não
invente IDs nem trate o cadastro do agent como rota.

Quando a superfície transacional de WhatsApp for aplicável:

```bash
ravi whatsapp group create "<nome-do-grupo>" --agent <agent-id>
```

Mesmo nesse fluxo, leia de volta a rota antes de considerar o wiring correto.

### 7. Fazer smoke controlado e provar pelo trace

Dispare uma mensagem sintética pelo canal ou mecanismo operacional aprovado. Não
use atalhos de interação removidos como prova de admissão.

Depois leia a sessão real:

```bash
ravi sessions trace <session-name-or-key> \
  --explain \
  --json
```

O trace deve confirmar:

- `route.resolved` para o agent quando houver canal externo;
- `adapter.request` no provider/target esperado;
- `assistant.message`;
- `turn.complete`;
- emissão e entrega observada quando houver resposta externa.

Filtre por `--message`, `--run`, `--turn` ou `--correlation` quando precisar
isolar o smoke. Não use `--show-user-prompt`, `--show-system-prompt` ou `--raw`
em relatórios que possam expor dados sensíveis.

Em qualquer divergência, pare na camada divergente. Não faça reset/restart nem
amplie permissões como tentativa genérica de correção.

## Administração após a admissão

### Alterar runtime

Associar um preset limpa o modelo direto atomicamente:

```bash
ravi agents set <agent-id> modelPreset <preset-id> --json
```

Associar um modelo direto limpa a referência ao preset:

```bash
ravi agents set <agent-id> model <model-selector> --json
```

Para remover somente a referência ao preset:

```bash
ravi agents set <agent-id> modelPreset clear --json
```

Overrides de prompt, task, profile ou sessão podem prevalecer sobre o agent.
Após uma mudança, repita `agents show`, `continuity show/explain` e o smoke
quando a alteração afetar o alvo operacional.

### Propriedades comuns

```bash
ravi agents set <agent-id> name "<nome>" --json
ravi agents set <agent-id> effort medium --json
ravi agents set <agent-id> dmScope per-peer --json
ravi agents set <agent-id> groupDebounceMs 2000 --json
```

Valores de `dmScope`: `main`, `per-peer`, `per-channel-peer` e
`per-account-channel-peer`.

### Debounce e modo

```bash
ravi agents debounce <agent-id> <ms>
ravi agents debounce <agent-id> 0
ravi agents debounce <agent-id>
ravi agents set <agent-id> mode active --json
ravi agents set <agent-id> mode sentinel --json
```

Use `sentinel` somente quando o desenho operacional exigir essa semântica.

### Execução remota

```bash
ravi agents set <agent-id> remote <vmid|hostname|worker:id> --json
ravi agents set <agent-id> remoteUser <unix-user> --json
```

Valide conectividade e autoridade remotas antes de colocar uma rota em produção.

### Deletar

Delete é destrutivo e exige decisão explícita. Antes, leia dependentes por
`agents show`, sessões e rotas. Remover o cadastro não prova que referências
operacionais externas foram removidas.

```bash
ravi agents delete <agent-id> --json
```

## Checklist de aceitação

Um agent só está admitido quando:

1. `agents show --json` confirma diretório e runtime gravados.
2. `skills inspect --json` contém as skills customizadas necessárias, e skills
   de sistema derivam de capabilities.
3. `permissions materialize` confirma capabilities mínimas.
4. `runtime continuity show/explain` foi lido antes de afirmar o target efetivo.
5. Quando há canal externo, `instances routes show` confirma a rota.
6. O trace do smoke contém dispatch, request, resposta, terminal do turno e,
   quando aplicável, entrega observada.

Até todas as evidências existirem, o agent permanece em configuração.

## Anti-patterns

- Usar `AGENTS.md` como prova de autorização.
- Hardcodar modelo sem consultar preset e continuidade.
- Informar `--model` e `--model-preset` juntos.
- Conceder skill de sistema por grant manual.
- Dar `full-access` por padrão.
- Declarar rota correta sem readback.
- Declarar sucesso sem trace terminal.
- Resetar sessão ou reiniciar daemon como primeira tentativa.
- Editar SQLite, config gerada, cache ou cópia instalada da skill.

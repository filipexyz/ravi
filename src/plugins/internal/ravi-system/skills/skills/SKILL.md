---
name: skill-creator
description: |
  Guia para criar, instalar e inspecionar skills no Ravi. Use quando o usuário quiser:
  - Instalar skills oficiais do catálogo do Ravi
  - Instalar skills de um repositório ou path local
  - Listar ou ver o conteúdo de skills pelo CLI
  - Buscar, carregar e publicar skills da Biblioteca (organização e projeto)
  - Criar uma nova skill
  - Entender como skills funcionam
  - Configurar frontmatter de skills
  - Adicionar skills a plugins
---

# Skill Creator - Guia Completo

Skills estendem as capacidades do Claude. São arquivos markdown com instruções que Claude segue quando a skill é invocada.

## Contrato Do CLI

Rode com `--json` sempre que for decidir programaticamente. Com `--json`, falha sai em envelope `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.

Taxonomia de saída:

- `0` sucesso.
- `1` erro de execução (`SKILL_NOT_FOUND`, `AGENT_NOT_FOUND`, `SKILL_SOURCE_NOT_FOUND`, `SKILL_SOURCE_EMPTY`, `SKILL_SOURCE_UNAVAILABLE`, `SKILL_ALREADY_INSTALLED`). O envelope traz `suggestions` com nomes/ids reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido, `SKILL_SELECTION_REQUIRED`).
- `3` freio de política — não é erro. Nada foi gravado; revise o `plan` e repita com `--execute` somente nos casos freados abaixo.

Matriz KISS de `skills install`:

| Situação | Sem `--execute` | Próximo passo |
|---|---|---|
| Catálogo oficial ou path local, instalação aditiva (sem `--overwrite`) | instala imediatamente (exit 0) | confira o resultado; não repita com `--execute` |
| Fonte Git (shorthand, URL GitHub ou URL git) | dry-run (exit 3) antes de resolver a fonte remota | revise o plano mínimo e repita com `--execute` |
| Qualquer fonte com `--overwrite` | dry-run (exit 3) antes de substituir arquivos | revise o plano mínimo e repita com `--execute` |

O plano usa um `sourceLabel` controlado: exatamente `catalog`, `local` ou `git`, nunca um rótulo derivado da entrada. Ele não repete URL, path local, nome da fonte/repositório/skill nem conteúdo. Em Git, a seleção fica adiada e erros como `SKILL_NOT_FOUND` só podem aparecer depois de `--execute`; catálogo e fonte local podem validar a seleção antes de escrever.

`skills publish` (Biblioteca) sempre tem freio: sem `--execute` devolve o plano (exit 3). `skills search` e `skills show` só leem.

Sem freio (declarado): instalações aditivas do catálogo ou de path local; `skills sync` (re-materializa o que já existe no repo local; idempotente e reversível); e `skills grant`/`skills revoke` (reversíveis entre si, efeito ao vivo). Todos escrevem na hora.

Caso especial — batch: `skills grant-batch`/`skills revoke-batch` usam o `--dry-run` PRÉ-EXISTENTE como equivalente do freio: preview com contagem, exit 0, sem escrita. NÃO existe `--execute` nesses dois e o nome `--dry-run` é mantido por compatibilidade — sempre rode o `--dry-run` antes do write real.

Compact mode: `skills list` e `skills who` aceitam `--fields a,b,c` (ex.: `--fields name,source`).

Exemplos:

```bash
ravi skills install cli-creator                         # catálogo aditivo: instala agora
ravi skills install minha --source ./minhas-skills      # fonte local aditiva: instala agora
ravi skills install --source ~/.agents/skills/find-skills  # skill única local: instala agora, sem nome
ravi skills install find-skills --source vercel-labs/skills  # Git: plano mínimo (exit 3)
ravi skills install find-skills --source vercel-labs/skills --execute
ravi skills install cli-creator --overwrite             # overwrite: plano mínimo (exit 3)
ravi skills install cli-creator --overwrite --execute
ravi skills grant-batch --all-agents --all-skills --dry-run   # preview (equivalente do freio)
```

Checklist antes de responder sobre skills:

- Classifiquei a instalação pela fonte e por `--overwrite`, em vez de presumir que todo `install` exige confirmação?
- Em catálogo/path local aditivo, usei o resultado direto sem repetir com `--execute`?
- No exit 3, confirmei que `sourceLabel` é apenas `catalog`/`local`/`git`, sem URL/path/nome/conteúdo e, para Git, com seleção adiada antes de repetir com `--execute`?
- Consultei `suggestions` do envelope antes de declarar skill/agente inexistente?
- Em batch, rodei `--dry-run` antes do write real?

## CLI do Ravi

Use `ravi skills` para operar skills sem editar diretórios manualmente.

### Fonte Primária

A fonte primária do `ravi skills` é o catálogo oficial do Ravi:

```text
src/plugins/internal/**/skills/*/SKILL.md
```

Use fontes externas somente quando passar `--source`.

### Listar catálogo

```bash
ravi skills list
ravi skills list --json
```

### Listar instaladas

```bash
ravi skills list --installed
ravi skills list --installed --codex --json
```

### Ver uma skill

```bash
ravi skills show image
ravi skills show image --installed
ravi skills show find-skills --source vercel-labs/skills
ravi skills show bases --file references/query-ast.md   # um arquivo da skill (caminho relativo)
```

`show` termina com a lista `Files in this skill:`; com `--json`, sai `files[]` (SKILL.md primeiro) e, com `--file`, `file {path, content}`. Ler um arquivo conta como carregar a skill.

### Ver skills disponíveis em uma fonte

```bash
ravi skills list --source vercel-labs/skills
ravi skills list --source https://github.com/vercel-labs/skills/tree/main/skills/find-skills
```

### Instalar

`skills install` usa confirmação proporcional ao risco. Catálogo oficial e path local instalam diretamente quando a operação é aditiva. Fonte Git ou qualquer instalação com `--overwrite` retorna dry-run (exit 3); revise o plano mínimo e repita com `--execute`.

O dry-run de fonte Git acontece antes de baixar ou inspecionar o repositório. No plano, `sourceLabel` é somente `catalog`, `local` ou `git`; ele não inclui URL, path local, nome da fonte/repositório/skill nem conteúdo.

```bash
ravi skills install image                         # catálogo aditivo: instala agora
ravi skills install minha --source ./minhas-skills # local aditivo: instala agora
ravi skills install find-skills --source vercel-labs/skills # Git: dry-run (exit 3)
ravi skills install find-skills --source vercel-labs/skills --execute
ravi skills install image --overwrite             # dry-run (exit 3)
ravi skills install image --overwrite --execute
```

Quando um catálogo/fonte contém várias skills, não instale implicitamente todas: passe um nome ou `--all` (senão `SKILL_SELECTION_REQUIRED`, exit 2, com os nomes em `suggestions`). Uma fonte local com uma única skill (o diretório que contém `SKILL.md`, ou o próprio `SKILL.md`) instala sem nome. Paths relativos resolvem no cwd de quem chama e `~/...` é o HOME, não um shorthand GitHub.

O destino canônico de skills instaladas pelo operador é `~/ravi/plugins/ravi-user-skills/skills/<skill>`.
Depois da instalação, o CLI sincroniza a materialização em `~/.codex/skills` quando aplicável.

### Skill que o harness anuncia mas o gate nega

Skills que só existem no disco (ex.: `~/.agents/skills/find-skills`) não entram na allowlist sozinhas. Para um agente com allowlist, o caminho é instalar no Ravi e depois grantar — nunca contornar o gate lendo o arquivo por outro comando:

```bash
ravi skills install --source ~/.agents/skills/find-skills   # skill única local: instala agora
ravi skills grant <agent> find-skills                        # dá visibilidade (efeito ao vivo)
ravi skills inspect <agent>                                  # confere a allowlist
```

`SKILL_NOT_AUTHORIZED` nomeia a skill e o agente (`Skill 'x' is not authorized for agent 'y'.`) e aponta o remédio certo para a origem da skill. `skills grant` de uma skill não instalada falha com `SKILL_NOT_FOUND` e sugere o `install --source`.

Skill que já vem no catálogo do Ravi (ex.: `bases`) não se instala: basta `ravi skills grant <agent> <skill>` ou a capability `use:skill:<skill>`. `use:skill:*` (que o `full-access` materializa) e `admin:system:*` liberam a leitura sob demanda de qualquer skill do catálogo ou instalada, sem colocá-la no catálogo do prompt. Rode o grant sozinho: uma linha de shell que também lê a skill negada é rejeitada inteira, e o grant dela não roda.

### Sincronizar

```bash
ravi skills sync
```

## Biblioteca: skills da organização e do projeto

A Biblioteca guarda no Console as skills que a organização compartilha. Uma skill é da organização (todo agente de todo projeto vê) ou de um projeto (só os agentes daquele projeto veem). O formato é o mesmo de qualquer skill: uma pasta com `SKILL.md` e, se quiser, `references/`.

Refs:

- `org/<slug>`: skill da organização.
- `<projeto>/<slug>`: skill de um projeto (ex.: `clinica/triagem`).

### Buscar

```bash
ravi skills search agenda                 # locais + Biblioteca, ignora maiúsculas e acentos
ravi skills search "nota fiscal" --json   # cada item traz ref, source, scope, version, authorized e next
ravi skills search bases --local          # só as locais, sem Console
```

`source` é `system` (vem com o Ravi), `installed` ou `library`. O campo `next` traz o comando exato para carregar. Sem `ravi login`, a busca devolve só as locais e avisa em `library.hint`. Sem rede, a Biblioteca responde do cache local e o resultado vem com `stale: true`.

### Carregar

```bash
ravi skills show org/agenda-semanal
ravi skills show clinica/triagem --file references/horarios.md
```

Um nome sem barra resolve primeiro nas skills locais (as do Ravi e as instaladas sempre ganham); só sem match local o Ravi procura na Biblioteca (organização + projeto do agente). Dentro de um agente, use sempre o ref completo que o `search` devolve: o gate de skills confere o nome antes de o comando rodar e não sabe a que skill da Biblioteca um nome solto se refere. Uma skill carregada fica no cache e continua funcionando sem rede (`stale: true`).

Permissão: igual às skills locais. `full-access` (`use:skill:*`) passa; os outros agentes precisam de grant ou capability:

```bash
ravi skills grant atendente org/agenda-semanal     # grava o id org:agenda-semanal
ravi skills grant atendente clinica/triagem        # grava project:clinica:triagem
```

Capabilities usam os mesmos ids: `use:skill:org:agenda-semanal`, `use:skill:org:*` (todas da organização), `use:skill:project:clinica:*` (todas do projeto). Skill de outro projeto que não o do agente só passa com grant explícito daquele ref (`LIBRARY_SKILL_OUT_OF_VIEW`, exit 3).

Conversa com gente de fora da organização: só skills publicadas com `--external` são carregadas em turnos que não são do próprio operador (o terminal, a conversa direta dele, as rotinas dele). As outras falham com `LIBRARY_SKILL_EXTERNAL_DENIED` (exit 3) e nem aparecem no `search`. Responda sem a skill.

### Publicar

Publicar muda o que todo agente da organização ou do projeto carrega, então tem freio: sem `--execute` o comando valida a pasta, lê a versão publicada e devolve o plano (exit 3); com `--execute` publica.

```bash
ravi skills publish ./agenda-semanal --scope org                     # plano (exit 3)
ravi skills publish ./agenda-semanal --scope org --execute
ravi skills publish ./triagem --scope clinica --note "novos horários" --execute
ravi skills publish ./faq --scope org --external --execute           # liberada para conversa com gente de fora
```

Regras checadas antes de qualquer request: `SKILL.md` na raiz com `description` no frontmatter; até 100 arquivos de texto UTF-8, 256 KiB cada e 1 MiB no total; caminhos com `A-Z a-z 0-9 . _ - /` (dotfiles e `node_modules` ficam fora). O slug vem de `--slug`, senão do `name` do frontmatter, senão do nome da pasta. Os nomes das skills do Ravi e o prefixo `ravi-` são reservados (`LIBRARY_SLUG_RESERVED`). Conteúdo idêntico ao publicado não cria versão (`unchanged: true`). Se alguém publicou antes de você, o `--execute` falha com `CONFLICT` (`reason: stale_base`): rode de novo sem `--execute` para ver o plano novo.

## Estrutura de uma Skill

```
skills/
└── minha-skill/
    └── SKILL.md          # Arquivo principal (obrigatório)
    ├── template.md       # Template opcional
    ├── examples/         # Exemplos opcionais
    └── scripts/          # Scripts auxiliares
```

## Formato do SKILL.md

```yaml
---
name: nome-da-skill
description: |
  Descrição detalhada. Claude usa isso para decidir
  quando carregar a skill automaticamente.
---

# Título da Skill

Instruções que Claude segue quando a skill é ativada.
```

## Frontmatter - Todas as Opções

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| `name` | Não | Nome da skill. Se omitido, usa o nome da pasta |
| `description` | Recomendado | Quando usar. Claude usa pra decidir auto-invocação |
| `argument-hint` | Não | Hint no autocomplete: `[issue-number]` |
| `disable-model-invocation` | Não | `true` = só user pode invocar (default: false) |
| `user-invocable` | Não | `false` = esconde do menu / (default: true) |
| `allowed-tools` | Não | Tools permitidas: `Read, Grep, Glob` |
| `model` | Não | Modelo específico para a skill |
| `context` | Não | `fork` = roda em subagent isolado |
| `agent` | Não | Tipo de subagent quando `context: fork` |
| `hooks` | Não | Hooks específicos da skill |

## Tipos de Skills

### 1. Skill de Referência (conhecimento)
Claude aplica ao trabalho atual. Roda inline.

```yaml
---
name: api-conventions
description: Padrões de API do projeto
---

Ao criar endpoints:
- Use nomes RESTful
- Retorne erros consistentes
- Valide requests
```

### 2. Skill de Tarefa (ação)
Instruções passo-a-passo. Geralmente user-invoked.

```yaml
---
name: deploy
description: Deploy para produção
context: fork
disable-model-invocation: true
---

Deploy da aplicação:
1. Rodar testes
2. Build
3. Push para produção
```

## Controle de Invocação

| Configuração | User pode | Claude pode | Uso |
|--------------|-----------|-------------|-----|
| (default) | Sim | Sim | Skills gerais |
| `disable-model-invocation: true` | Sim | Não | Ações com side-effects |
| `user-invocable: false` | Não | Sim | Conhecimento de background |

## Variáveis de Substituição

| Variável | Descrição |
|----------|-----------|
| `$ARGUMENTS` | Todos os argumentos passados |
| `$ARGUMENTS[N]` ou `$N` | Argumento específico (0-indexed) |
| `${CLAUDE_SESSION_ID}` | ID da sessão atual |
| `` !`command` `` | Executa comando e insere output |

## Exemplo: Skill com Argumentos

```yaml
---
name: fix-issue
description: Corrige uma issue do GitHub
disable-model-invocation: true
---

Corrigir issue #$ARGUMENTS:

1. Ler descrição da issue
2. Implementar correção
3. Escrever testes
4. Criar commit
```

Uso: `/fix-issue 123`

## Exemplo: Skill com Contexto Dinâmico

```yaml
---
name: pr-summary
description: Resume um PR
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Contexto do PR
- Diff: !`gh pr diff`
- Comentários: !`gh pr view --comments`

## Tarefa
Resuma este PR...
```

## Onde Colocar Skills

| Local | Caminho | Alcance |
|-------|---------|---------|
| Pessoal | `~/.claude/skills/` | Todos os projetos |
| Projeto | `.claude/skills/` | Este projeto |
| Plugin | `plugin/skills/` | Onde plugin está ativo |

## Criando uma Skill - Passo a Passo

1. **Criar diretório:**
```bash
mkdir -p ~/.claude/skills/minha-skill
```

2. **Criar SKILL.md:**
```bash
cat > ~/.claude/skills/minha-skill/SKILL.md << 'EOF'
---
name: minha-skill
description: Descrição clara do que faz e quando usar
---

Instruções aqui...
EOF
```

3. **Testar:**
```
/minha-skill
```

## Dicas

- Mantenha SKILL.md < 500 linhas
- Use arquivos separados para referências longas
- Descrição clara = melhor auto-invocação
- `allowed-tools` restringe para segurança
- `context: fork` isola side-effects

## Skills em Plugins

Para distribuir skills:

```
meu-plugin/
├── .claude-plugin/
│   └── plugin.json
└── skills/
    └── minha-skill/
        └── SKILL.md
```

Skills de plugins usam namespace: `/meu-plugin:minha-skill`

---
name: skill-creator
description: |
  Guia para criar, instalar e inspecionar skills no Ravi. Use quando o usuário quiser:
  - Instalar skills oficiais do catálogo do Ravi
  - Instalar skills de um repositório ou path local
  - Listar ou ver o conteúdo de skills pelo CLI
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
- `1` erro de execução (`SKILL_NOT_FOUND`, `AGENT_NOT_FOUND`). O envelope traz `suggestions` com nomes/ids reais parecidos — consulte antes de concluir "não existe".
- `2` erro de uso (flag/argumento inválido).
- `3` freio de escrita — não é erro. Nada foi gravado; o envelope traz `dryRun:true` e `plan` com fonte e destino exatos do que `--execute` faria. Revise e repita com `--execute`.

Onde o freio existe hoje: `skills install` (instala código de terceiros no ambiente — a escrita mais arriscada do domínio) é dry-run por default e exige `--execute`. Nome inexistente falha ANTES do freio (exit 1 `SKILL_NOT_FOUND`, nunca 3).

Sem freio (declarado): `skills sync` (re-materializa o que já existe no repo local; idempotente e reversível) e `skills grant`/`skills revoke` (reversíveis entre si, efeito ao vivo) escrevem na hora.

Caso especial — batch: `skills grant-batch`/`skills revoke-batch` usam o `--dry-run` PRÉ-EXISTENTE como equivalente do freio: preview com contagem, exit 0, sem escrita. NÃO existe `--execute` nesses dois e o nome `--dry-run` é mantido por compatibilidade — sempre rode o `--dry-run` antes do write real.

Compact mode: `skills list` e `skills who` aceitam `--fields a,b,c` (ex.: `--fields name,source`).

Exemplos freados:

```bash
ravi skills install cli-creator                 # dry-run: plano fonte→destino (exit 3)
ravi skills install cli-creator --execute       # instala de verdade
ravi skills install --source org/repo --all --execute
ravi skills grant-batch --all-agents --all-skills --dry-run   # preview (equivalente do freio)
```

Checklist antes de responder sobre skills:

- Tratei exit 3 como freio (revisei o `plan` fonte→destino) e não como falha?
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
```

### Ver skills disponíveis em uma fonte

```bash
ravi skills list --source vercel-labs/skills
ravi skills list --source https://github.com/vercel-labs/skills/tree/main/skills/find-skills
```

### Instalar

`skills install` é dry-run por default: sem `--execute` ele só mostra o plano fonte→destino e sai com exit 3, sem escrever nada.

```bash
ravi skills install image                # dry-run: mostra o plano (exit 3)
ravi skills install image --execute
ravi skills install --all --execute
ravi skills install find-skills --source vercel-labs/skills --execute
ravi skills install --source ./minhas-skills --all --execute
```

Quando um catálogo/fonte contém várias skills, não instale implicitamente todas: passe um nome ou `--all`.

O destino canônico de skills instaladas pelo operador é `~/ravi/plugins/ravi-user-skills/skills/<skill>`.
Depois da instalação, o CLI sincroniza a materialização em `~/.codex/skills` quando aplicável.

### Sincronizar

```bash
ravi skills sync
```

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

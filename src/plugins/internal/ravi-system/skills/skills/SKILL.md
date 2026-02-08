---
name: skill-creator
description: |
  Guia para criar skills no Claude Code. Use quando o usuário quiser:
  - Criar uma nova skill
  - Entender como skills funcionam
  - Configurar frontmatter de skills
  - Adicionar skills a plugins
---

# Skill Creator - Guia Completo

Skills estendem as capacidades do Claude. São arquivos markdown com instruções que Claude segue quando a skill é invocada.

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

# Ravi Tag System v0

`tags` é um sistema único de classificação para ativos do Ravi.

## Tese

Não existem "tags de agent" e "tags de sessão" separadas.

Existe:

- `tag_definitions`
- `tag_bindings`

O binding é polimórfico e liga uma tag a um ativo:

- `agent`
- `session`

Outros tipos (`task`, `route`, `contact`) podem entrar depois sem trocar o modelo.

## Modelo

### `tag_definitions`

- `id`
- `slug`
- `label`
- `description`
- `kind` (`system` | `user`)
- `metadata_json`
- `created_at`
- `updated_at`

### `tag_bindings`

- `id`
- `tag_id`
- `asset_type`
- `asset_id`
- `metadata_json`
- `created_by`
- `created_at`
- `updated_at`

`metadata_json` existe tanto na tag quanto no binding.

Leitura prática:

- metadata da tag = informação global da classificação
- metadata do binding = contexto daquela tag naquele ativo

## Regras do v0

- `slug` é estável e único
- `attach` é idempotente
- reanexar o mesmo `tag + asset` atualiza `metadata_json`
- o CLI valida existência do alvo (`agent`/`session`) antes de gravar
- não existe herança automática no v0
- não existe ontologia/hierarquia de tags no v0

## CLI

```bash
ravi tags create <slug> --label "..."
ravi tags list
ravi tags show <slug>
ravi tags attach <slug> --agent <id> [--meta '{"team":"core"}']
ravi tags attach <slug> --session <name> [--meta '{"project":"overlay"}']
ravi tags detach <slug> --agent <id>
ravi tags detach <slug> --session <name>
ravi tags search [--tag <slug>] [--agent <id>] [--session <name>]
```

## Exemplos

```bash
ravi tags create core --label "Core"
ravi tags create project.overlay --label "Project Overlay" --meta '{"color":"green"}'

ravi tags attach core --agent dev --meta '{"team":"platform"}'
ravi tags attach project.overlay --session dev --meta '{"role":"investigation"}'

ravi tags search --tag project.overlay
ravi tags search --session dev
```

## O que fica fora por enquanto

- permissões dirigidas por tags
- filtros automáticos de UI
- eventos/stream de tags
- inheritance `agent -> session`
- regras de resolução por taxonomia

O objetivo do v0 é só um:

criar uma base única, simples e queryable para classificar agents e sessões sem codificar tudo no nome.

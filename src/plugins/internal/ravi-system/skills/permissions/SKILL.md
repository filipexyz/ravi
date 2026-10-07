---
name: permissions-manager
description: |
  Inspeciona a autorização provider-runtime do Ravi. Use quando o usuário quiser:
  - Ver a cadeia ativa de providers de permissão
  - Verificar uma decisão provider-runtime
  - Materializar capabilities de um subject
  - Resolver denials com profiles/tags provider-owned
  - Aplicar autorização recorrente sem listas longas de capability
---

# Permissions Manager

O Ravi autoriza pelo **Permission Provider Runtime**. A superfície normal de
inspeção é:

```bash
ravi permissions status
ravi permissions check --permission <perm> --object-type <type> --object-id <id>
ravi permissions materialize --subject-type <type> --subject-id <id>
```

Fluxo agent-first para destravar um denial:

```bash
ravi permissions resolve <denial-id>
ravi permissions resolve <denial-id> --apply
```

Quando não existir `denialId`, monte um plano explícito:

```bash
ravi permissions allow <profile> \
  --to agent:<executor-agent-id> \
  --capabilities <permission>:<objectType>:<objectId>

ravi permissions allow <profile> ... --apply
```

`allow` e `resolve` fazem dry-run por padrão. Só persistem com `--apply`.
Eles não gravam num grafo legado: orquestram superfícies provider-owned
existentes, como permission tags, grants de contato por chat e
`agent.defaults.runtimePermissions`.

## Grants para um usuário/contato (escopo de chat)

Permissão de usuário é **por chat**. Threads herdam o chat. O efetivo no turno
é `teto do agent ∩ caps do contato naquele chat`: o grant só destrava o que o
agent já pode fazer.

```bash
# Só neste chat (dentro de um turno, `--chat current` resolve o chat atual)
ravi permissions allow <profile> --to contact:<id> --chat current --agent <executor> --json
ravi permissions allow <profile> --to contact:<id> --chat current --agent <executor> --apply --json

# Todos os chats com uma tag de chat
ravi permissions allow <profile> --to contact:<id> --chat-tag <tag> --apply --json

# Global: só depois que o humano confirmar explicitamente
ravi permissions allow <profile> --to contact:<id> --force --apply --json

# Revogar e listar com os mesmos filtros
ravi permissions deny <profile> --to contact:<id> --chat <chat-id> --apply --json
ravi permissions list --chat <chat-id> --json
```

Regras:

- Sem `--chat`, `--chat-tag` ou `--force`, `allow|deny|list` com contato
  recusa com `CHAT_SCOPE_REQUIRED`. Use a sugestão `--chat <id>` do erro.
- Antes de `--force`, pergunte ao humano: "só neste grupo, ou em todos os
  chats?". Global é exceção, não padrão.
- Depois de `allow`/`deny`, confira `confirmation`: `scopes`
  (`chat:<id>`, `chat-tag:<tag>` ou `global`), `global`, `force`, `profile` e
  `capabilities`. Se `global=true` sem o humano ter pedido, desfaça com
  `deny ... --force --apply`.
- O primeiro grant num chat deixa o chat **governado**: outros contatos ali
  ficam sem tools até receberem grant próprio. Leia `hints` e avise o humano.
- Passe `--agent <executor>` para garantir que o teto do agent inclui o
  profile; grant de contato sozinho não amplia o agent.

Só use capability solta quando ainda não existir profile adequado. Nesse caso,
coloque a capability em `--capabilities` como bootstrap de um profile estreito.
`full-access` é break-glass e exige aprovação explícita do operador. O profile
materializa `admin system:*`, `execute executable:*`, `use tool:*`,
`use toolgroup:*` e `use skill:*` (lê qualquer skill que o Ravi conhece). Em turnos `turn-runtime` com ator resolvido, o PreToolUse
do Bash relê esse teto do executor no próximo check — sem reset de sessão.
Não pede `full-access` para denial operacional comum; não confunda com tag
`permission.admin` de contato.

Contrato de guidance:

- `canonicalCapability`: capability técnica faltante.
- `inspectCommands`: comandos usados para provar o estado atual.
- `preferredPath`: profile/tag provider-owned recomendado.
- `rawCapabilityFallback`: capability crua só como bootstrap temporário.
- `breakGlass`: aviso explícito para não pedir `full-access`.
- `requestShape`: forma correta de pedir autorização ao operador.

Ao consumir JSON de denial/check, use esse envelope. Não parseie frase de erro
para decidir o que pedir.

Regras:

- `ravi permissions status/check/materialize/list` são inspeção
  provider-runtime.
- `ravi permissions allow/deny/resolve` são orquestração provider-owned com
  dry-run obrigatório por padrão e `--apply` explícito.
- `ravi agents permissions` grava em `agent.defaults.runtimePermissions`.
  Use diretamente apenas para correção agent-only; para fluxos iniciados por
  humanos, prefira `ravi permissions allow/resolve`.
- Profiles de runtime: `bootstrap` (piso de nascimento), `chat-only`
  (conversation only; sentinel explícito `{ profile: "chat-only" }`),
  `full-access` (break-glass), `none`/`clear`/`off` (apaga overlay e volta ao
  piso bootstrap). `none` não é zero-authority.
- `runtime-bootstrap`, `agent-default-capabilities`,
  `agent-identity-permissions` e `contact-policy-permissions` são os
  materializers padrão. `chat-only` suprime a injeção de `runtime-bootstrap`
  no agent e no `agent_identity` derivado.
- `operator-control` é o authorization provider explícito para operador local;
  ele não materializa capabilities de agent e não autoriza execução de tools.
- O contexto efetivo de um turno externo usa `authorityMode=agent-identity`:
  capabilities do executor agent projetadas em
  `agent_identity:<agent>:<compartment>`, intersectadas com turn caps quando
  existirem.
- Ator/contact e chat/surface são provenance, invocação e compartimento por
  default; eles não são branches obrigatórios de tool authority. Exceção: em
  chat governado por grants de contato, `actorAuthorizationMode=user-overlay`
  e o efetivo é `agent_identity ∩ caps do contato no chat`. Ator desconhecido
  continua falhando fechado.
- O modelo antigo `agent ∩ actor ∩ surface ∩ turn` está aposentado na criação
  de contexto runtime; trate menções a ele como histórico/test fixture.
- Tags são labels; elas não concedem autoridade sem provider explícito.
- Tags de permissão só concedem autoridade quando a tag definition é
  provider-owned (`kind=system`, `source=permissions`) e declara capabilities.
- Não peça `full-access` para resolver denial operacional comum.

Capability format:

```text
<permission>:<objectType>:<objectId>
```

Exemplos:

```bash
ravi permissions materialize --subject-type agent --subject-id main --json
ravi permissions materialize --subject-type agent_identity --subject-id <agent-id>:chat:<chat-id> --json
ravi permissions materialize --subject-type contact --subject-id <contact-id> --json
ravi permissions check --permission view --object-type agent --object-id worker --local-operator
ravi permissions resolve <denial-id>
ravi permissions allow image-generation --to agent:image-agent --capabilities mutate:image:generate
ravi tags show permission-family --json
```

CLI command capabilities:

- Comandos decorados com `@CommandAccess` usam capabilities semânticas:
  `<read|mutate>:<resource>:<action>`.
- Exemplos corretos: `read:skills:show`, `read:self:permissions`,
  `read:tasks.profiles:list`, `read:tasks.profiles:*`, `read:cron:show`.
- `execute:group:<group>` e `execute:group:<group>_<command>` existem como
  compatibilidade, mas não são o formato recomendado para novas instruções.
- A capability canônica indicada pelo denial deve bastar para repetir o mesmo
  comando. Nunca peça `execute:group:*` depois que o grant semântico já foi
  aplicado; isso indica regressão no pipeline de autorização.
- Evite formato com `resource` e `action` fundidos por ponto. O formato
  canônico separa a action no terceiro segmento, como `read:skills:show`.

Ao orientar outro agente, responda com:

1. a capability canônica que faltou;
2. qual ponto bloqueou, se disponível: agent identity/executor, ator
   desconhecido, turn cap, provider runtime ou legado actor/surface;
3. o profile/tag provider-owned recomendado para `agent:<executor>`;
4. o comando `ravi permissions resolve <denial-id>` quando houver denial id;
5. aviso claro se a alternativa for break-glass.

Forma recomendada de pedido:

```text
Preciso do profile/tag <slug> para <workflow> em <escopo>.
Evidência: faltou <canonicalCapability>; inspecionei com <command>.
TTL: temporário por padrão; permanente só se o operador explicitar.
```

Para denials com `authorityMode=agent-identity`, não peça grant para cada
contato ou chat só porque `actorCapabilityCount`/`surfaceCapabilityCount` é 0.
Isso é esperado: o fix recorrente é no agent executor/agent identity, salvo se
o erro for ator desconhecido ou uma policy de invocação explícita.

Se o denial tiver `actorAuthorizationMode=user-overlay` (bloqueio
`user_overlay_missing_grant`), o chat é governado: o fix é um grant do profile
para aquele contato **naquele chat** (`ravi permissions resolve <denial-id>`
já monta isso), não global.

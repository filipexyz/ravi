---
name: permissions-manager
description: |
  Inspeciona a autorização provider-runtime do Ravi. Use quando o usuário quiser:
  - Ver a cadeia ativa de providers de permissão
  - Verificar uma decisão provider-runtime
  - Materializar capabilities de um subject
  - Entender a superfície atual sem comandos antigos de mutação
---

# Permissions Manager

O Ravi autoriza pelo **Permission Provider Runtime**. A superfície normal é:

```bash
ravi permissions status
ravi permissions check --permission <perm> --object-type <type> --object-id <id>
ravi permissions materialize --subject-type <type> --subject-id <id>
```

Para configurar permissões de agent, use:

```bash
ravi agents permissions <agent-id>
ravi agents permissions <agent-id> full-access
ravi agents permissions <agent-id> bootstrap --capabilities view:agent:*
```

Regras:

- `ravi permissions` é somente inspeção provider-runtime.
- `ravi agents permissions` grava em `agent.defaults.runtimePermissions`.
- `agent-runtime-permissions`, `contact-policy-permissions` e
  `runtime-bootstrap` são os materializers padrão.
- O contexto efetivo de um turno externo continua sendo limitado por executor,
  ator, superfície e capabilities do turno.
- Tags são labels; elas não concedem autoridade sem provider explícito.

Capability format:

```text
<permission>:<objectType>:<objectId>
```

Exemplos:

```bash
ravi agents permissions main bootstrap --capabilities view:agent:*
ravi agents permissions steward bootstrap --capabilities read:skills:show,read:self:whoami,read:self:permissions,read:tasks.profiles:*,read:tasks:list,read:cron:show
ravi permissions materialize --subject-type agent --subject-id main --json
ravi permissions check --permission view --object-type agent --object-id worker --local-operator
```

CLI command capabilities:

- Comandos decorados com `@CommandAccess` usam capabilities semânticas:
  `<read|mutate>:<resource>:<action>`.
- Exemplos corretos: `read:skills:show`, `read:self:permissions`,
  `read:tasks.profiles:list`, `read:tasks.profiles:*`, `read:cron:show`.
- `execute:group:<group>` e `execute:group:<group>_<command>` existem como
  compatibilidade, mas não são o formato recomendado para novas instruções.
- Evite formato com `resource` e `action` fundidos por ponto. O formato
  canônico separa a action no terceiro segmento, como `read:skills:show`.

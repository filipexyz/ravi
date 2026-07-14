---
name: runtime-target-failover
description: |
  Gerencia a policy opt-in de fallback entre runtimes do Ravi. Use quando precisar:
  - Ver ou reordenar alvos Claude, Pi, Codex ou outros runtimes de um agent
  - Explicar por que um alvo foi selecionado, rejeitado ou esgotado
  - Ativar, substituir ou remover uma policy de runtime targets
  - Diagnosticar credenciais gerenciadas sem expor tokens
---

# Runtime Target Failover

Use esta skill para operar a policy que decide a ordem de tentativa dos runtimes de um agent.

## Modelo Mental

- a policy é opt-in por agent
- cada alvo tem um `id` estável e um provider, como `claude`, `pi` ou `codex`
- `ordered` segue a ordem configurada
- `health-aware` usa histórico de falhas da sessão e a ordem configurada como desempate
- credenciais são gerenciadas separadamente; a policy só declara requisitos e IDs de credenciais gerenciadas
- falha classificada como elegível avança ao próximo alvo; falha terminal encerra o turno
- a configuração persiste no cadastro do agent e sobrevive a restart do daemon

## Comece Pelo CLI

O help do CLI é a fonte operacional de verdade:

```bash
ravi runtime targets --help
ravi runtime targets show --help
ravi runtime targets set --help
ravi runtime targets reorder --help
ravi runtime targets explain --help
```

## Fluxo Canônico

1. Veja a policy e copie os IDs estáveis:

```bash
ravi runtime targets show --agent <agent-id> --json
```

2. Reordene usando uma permutação exata de todos os IDs:

```bash
ravi runtime targets reorder --agent <agent-id> \
  --order codex-main,claude-main,pi-main --json
```

3. Confirme o estado persistido e rode o preflight stateless:

```bash
ravi runtime targets show --agent <agent-id> --json
ravi runtime targets explain --agent <agent-id> --json
```

Para criar ou substituir a policy inteira, use `set --policy-json` conforme o help. Para remover
somente a policy de failover, use `clear --agent <agent-id>`.

## Guardrails

- use IDs de `show`; não ordene por nome de provider, pois pode haver vários alvos do mesmo provider
- `--order` deve conter cada ID exatamente uma vez; listas parciais, duplicadas ou desconhecidas falham sem mutação
- não passe token, API key ou segredo no JSON da policy
- não altere credenciais só para reordenar alvos
- não é necessário reiniciar o daemon após `set`, `reorder` ou `clear`
- confirme toda mutação com `show`; `explain` mostra provenance e rejeições sem
  avaliar cooldown/circuito da sessão

## Diagnóstico

Se um alvo for rejeitado, verifique primeiro a configuração efetiva e depois a disponibilidade da
credencial, sem imprimir o segredo:

```bash
ravi runtime targets explain --agent <agent-id> --json
ravi runtime credentials status --json
ravi sessions trace <session>
```

Se o CLI instalado não listar `runtime targets`, confirme a versão/bundle em execução antes de
reescrever policy ou código. Uma CLI antiga e um daemon novo podem divergir.

## Referência Canônica

- spec: `runtime/target-failover/operator-cli`
- contrato base: `runtime/target-failover`
- CLI: `ravi runtime targets --help`

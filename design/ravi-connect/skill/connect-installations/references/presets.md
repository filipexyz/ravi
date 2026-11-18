# Presets

Só existem dois. Estão fixos em `assets/connect.js` e em `scripts/pair.ts`; mudar um preset é mudar os dois arquivos e passar por revisão, nunca por pedido de página.

Capacidade = `kind:resource:action`, exatamente como no `@CommandAccess` do comando (o gateway casa `permission:objectType:objectId`). Os nomes abaixo foram conferidos nos decorators de `src/cli/commands` e aceitos pelo gateway real no teste.

## Preset + escopo

A capacidade do comando sozinha não mostra nada. O gateway filtra pelo escopo (`src/permissions/scope.ts`: `filterAccessibleSessions`, `canAccessSession`, `canViewAgent`): com só `read:sessions:list`, a lista volta vazia, `agents list` mostra só o agente da própria chave, e `sessions info` e `sessions send` dão erro 422 `SESSION_NOT_FOUND` (medido, rodada 6 de `MEASURED.md`).

Por isso cada chave leva também o escopo que o dono pôs na config de cada instalação:

| Config | Capacidade | O que libera |
|---|---|---|
| `scope.sessions: ["<nome>"]` | `access:session:<nome>` | a sessão aparece em `sessions list`, responde em `sessions info`, pode receber `sessions send` (só no `conversar`) e tem stream próprio `GET /api/v1/_stream/sessions/<nome>` |
| `scope.agents: ["<id>"]` | `view:agent:<id>` | o agente aparece em `agents list` |

Nomes exatos, um por um. Nunca `access:session:*` nem `view:agent:*`: curinga fica fora de qualquer chave deste fluxo. A rodada 6 mostrou que um nome só (`access:session:<nome>`) lista só aquela sessão.

## `ver` (só leitura do escopo)

| Capacidade | O que libera | Onde está |
|---|---|---|
| `read:context:whoami` | `context whoami` | `commands/context.ts` |
| `read:sessions:list` | `sessions list` (só as sessões do escopo) | `commands/sessions.ts` |
| `read:sessions:info` | `sessions info` (só as sessões do escopo) | `commands/sessions.ts` |
| `read:agents:list` | `agents list` (o próprio agente + os do escopo) | `commands/agents.ts` |

Leitura inclui conteúdo: o stream de uma sessão do escopo traz ao vivo o que acontece nela: mensagens, respostas, chamadas de ferramentas e seus resultados, eventos de runtime e entrega, e os pedidos de aprovação daquela sessão. O dono escolhe sessões que aceita mostrar assim na página.

## `conversar`

Tudo do `ver` mais:

| Capacidade | O que libera | Onde está |
|---|---|---|
| `mutate:sessions:send` | `sessions send` (risco `high`), só para sessões do escopo | `commands/sessions.ts` |

## O que a chave de link leva a mais

`mutate:context:issue`, para a página criar as próprias chaves de acesso de 1 hora. O gateway limita cada filha às capacidades e à validade do pai: pedir `admin:system:*` com a chave de link dá 403 (medido), e a filha nunca vive mais que o link. Quem impõe 1 hora é o `connect.js`, não o gateway (veja `limites.md`).

A chave emissora do dono (em disco) leva `mutate:context:issue` + as capacidades do `conversar` + o escopo daquela instalação + `read:context:info` (só para o helper conferir se um link já foi revogado; não mostra chave nenhuma e não vai para os links), por 89 dias. `bun ~/.ravi/pairing/pair.ts caps <instalação>` imprime esse `--allow`, e `status --probe` acusa emissora com capacidade a mais ou a menos. Ela não leva revoke.

## Fora, sempre

- `admin:*` e qualquer curinga (`*`), inclusive nas relações de escopo.
- `view:system:events`: o stream `events` assina o barramento inteiro (`>`, `channels.ts`) e entrega prompts e respostas de todos os agentes. Seria ler todas as conversas.
- `mutate:context:revoke`: o `context revoke` não confere dono. Uma chave com essa capacidade revoga o contexto de outro cliente pelo id, e revogar o contexto admin derruba tudo que veio dele (medido). Por isso a página nunca revoga. Quem revoga é o dono, com o comando que o helper devolve (padrão), ou o helper, se o dono criou a chave de revogação opcional.
- `mutate:context:prune`, `mutate:context:authorize`, `mutate:context:cleanup-agent-runtime`.
- Qualquer `mutate:agents:*`, `mutate:routes:*`, `mutate:instances:*`, `mutate:settings:*`: mudam quem responde e onde.
- `read:sessions:read`, `recap`, `trace`, `debug`: ficam fora do teste.
- Outras escritas de sessão (`ask`, `execute`, `inform`, `reset`, `delete`, `set-*`): o `conversar` para em `send`.

## A confirmar numa instalação real

- O admin real é ligado ao agente `bootstrap` e as filhas herdam esse agente. No teste com dois agentes e três sessões, só as sessões e agentes do escopo apareceram; falta ver isso com os dados reais.
- `sessions send` tem risco `high`; uma política de aprovação da instalação pode pedir aprovação humana para ele.

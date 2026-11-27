---
name: observers
description: |
  Vigia sessões do Ravi sem custo de modelo no caminho. Use quando precisar:
  - "Quero vigiar a sessão X": `ravi sessions observe` (aviso quando um turno dá errado, ou resumo de cada turno)
  - Saber o que o observador recebe, quanto custa e quais condições existem
  - Observador sem memória (`memory: none`) ou com memória (`rolling`)
  - Rules por global/agent/session/task/profile/tag, profiles Markdown e o observer embutido das tasks (`task-observer`)
---

# Observers

> Verbos: CAPTAR (extrair calado). Compõe com: bases.
> Solução com mais de uma peça? `ravi skills show solucoes` primeiro.

Observar é olhar o comportamento de **outra sessão do Ravi** (resposta, turno sem mensagem final, narração num chat, falha). Evento de fonte externa (GitHub, e-mail, comentário de page) não é observer: é `watch` + trigger (skill `triggers`).

## Quero vigiar a sessão X

```bash
ravi sessions observe xone-setup                  # avisa nesta sessão quando um turno dá errado
ravi sessions observe xone-setup --to main        # avisa em outra sessão
ravi sessions observe xone-setup --when turn.failed,chat.narration
ravi sessions observe xone-setup --follow         # resumo curto de todo turno terminado
ravi sessions observing --json                    # quem vigia quem
ravi sessions unobserve xone-setup [--to main]    # para
```

- **Sem flag = alertas.** O daemon confere as condições a cada turno terminado e só acorda quem vigia quando uma casa. Nenhum modelo roda para decidir.
- **Condições** (default: as quatro primeiras):

| condição | casa quando |
|---|---|
| `turn.no_final_reply` | o turno acabou sem resposta do agente depois da mensagem da pessoa, ou o agente trabalhou (tools) depois da última resposta. `@@SILENT@@` intencional não conta |
| `chat.narration` | duas ou mais respostas do agente num turno que um chat via (narração de trabalho num grupo de cliente) |
| `turn.failed` | o turno falhou |
| `tool.idle` | uma tool ficou parada (`tool.inactive`) no turno |
| `turn.interrupt` | o turno foi interrompido (fora do default) |

- **O aviso** chega como `[System] Inform: [from: ravi observer] …`, um turno isolado da sessão que vigia, no profile `compact`: um bloco por turno da fonte com o que a pessoa disse, quantas mensagens o agente mandou e a última, as tools em contagem e como o turno terminou. Ids, uso e custo ficam no metadado, fora do prompt.
- **Custo:** um turno da sessão que recebe, por aviso. Com `--follow` numa fonte movimentada isso é um turno por turno da fonte; prefira alertas.
- **Permissão:** é preciso alcançar as duas sessões (fora do escopo = `SESSION_NOT_FOUND`) e poder mutar o agent de quem recebe. Uma sessão não vigia a si mesma; sessão própria de trigger não é fonte nem recebe.
- Rodar `observe` de novo no mesmo par troca o modo no lugar; nunca cria um segundo vigia. Renomear a sessão mantém a observação.

## Observador dedicado: memória e custo

Quando o vigia não é uma conversa (é uma sessão observadora própria, criada por rule), o custo dominante é o histórico dela: um observador com memória relê todas as entregas anteriores a cada uma (medido em 23/11: ~556 mil tokens de cache por entrega no observador de voz do `main`, para uma entrega de ~400).

- `metadata.memory: "none"`: cada entrega começa conversa nova, só com as instruções do observador e aquela entrega. Use para veredito, alerta, contagem.
- `metadata.memory: "rolling"` (default): uma conversa só, entre entregas. Use só quando o observador precisa de estado (hipótese, voz).

```bash
ravi observers rules set meu-vigia <observer-agent> --scope session --source-session <fonte> \
  --profile compact --delivery end_of_turn --mode observe --meta '{"memory":"none"}'
```

Desligar a rule desliga os bindings dela na hora. Religar não reata os bindings de uma sessão que já está rodando: rode `ravi observers refresh <sessão> --reconcile attach-missing` (sem isso, eles voltam só quando a fonte partir de novo).

## Antes de criar qualquer rule

- Comece por `ravi sessions observe`. Rule própria só quando precisa de observer dedicado, de rule por agent/tag/profile ou de profile próprio.
- Não crie rules por padrão em sistemas novos.
- Não injete conteúdo do observer na sessão fonte.
- Não use modo `observe` com permissões mutáveis.
- Não reinicie daemon para validar profile; use `profiles preview|validate`.
- Tag de contato que muda não remove binding sozinha: faça a limpeza (`ravi observers ...`).

## Referências

Abra só o que precisar: `ravi skills show observers --file references/<arquivo>`.

- `cli.md`: contrato do CLI (`--json`, exit codes, freio do `rules rm`), lista de comandos e inspeção cruzada.
- `rules-e-profiles.md`: selectors, profiles Markdown, observer embutido das tasks, rule própria de status, observers por tag de contato.

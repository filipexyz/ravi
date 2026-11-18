# ravi-connect: uma Ravi Page que entra nas instalações do dono e continua logada

**Data:** 2026-11-18
**Status:** experimento para um primeiro teste nas máquinas do próprio dono. Não muda o gateway, não entra no pacote do npm e não está em `src/`.

## O que é

Uma página hospedada (`https://<org>-<projeto>.ravi.page`) pede acesso a uma ou mais instalações do Ravi do dono: a do computador dele e as de VPSs alcançadas por túnel SSH. O dono aprova uma vez, na conversa com o agente dele, e a página continua conectada nas visitas seguintes.

1. A página cria no navegador uma chave que não sai dele e mostra um pedido e uma frase de três palavras.
2. O dono manda o pedido ao agente. O agente confere, mostra a mesma frase e espera o "sim <FRASE>".
3. O agente emite, em cada instalação, uma chave de link de até 60 dias (`ravi context issue`) e devolve tudo num envelope que só aquele navegador abre.
4. A página guarda o envelope fechado e, a cada visita, cria sozinha chaves de acesso de 1 hora.

O que a página enxerga em cada instalação é uma lista de sessões e agentes que o dono escreve na config do helper. Há dois níveis de permissão: `ver` (só leitura) e `conversar` (leitura mais enviar mensagens às sessões listadas).

## Arquivos

| Caminho | O que é |
|---|---|
| `skill/connect-installations/SKILL.md` | A skill que o agente carrega: como montar a página e como tratar um pedido no chat |
| `skill/connect-installations/assets/connect.js` | Módulo da página: chave, pedido, frase, envelope, cartão "Conectar", chaves de acesso |
| `skill/connect-installations/scripts/pair.ts` | Helper do agente (Bun): confere, emite, sela, lista e desconecta |
| `skill/connect-installations/references/instalacao.md` | Preparação de cada instalação, feita uma vez pelo dono |
| `skill/connect-installations/references/presets.md` | As permissões de `ver` e `conversar`, e por que o resto fica fora |
| `skill/connect-installations/references/limites.md` | O que este teste não protege |
| `TESTE.md` | Roteiro do teste para o dono |
| `PEDIDO-LUIS.md` | Mudanças no gateway que tornariam isto um produto; todas dependem de aprovação |
| `MEASURED.md` | Registro das medições feitas com o código real do gateway e do CLI (em inglês) |
| `test/e2e/` | Teste de ponta a ponta: Chromium, o helper e dois gateways reais em estado isolado |
| `test/attacks/` | Scripts de ataque contra o helper e a página, com o resultado de cada um |

## Como testar

Siga `TESTE.md`. Antes dele, `skill/connect-installations/references/instalacao.md` em cada instalação, e leia `references/limites.md`.

## O que foi verificado

- `test/e2e`: 81 casos, todos passam. Usa o `connect.js` e o `pair.ts` deste pacote, dois processos do código real do gateway e o ponto de entrada real do CLI no lado remoto.
- `test/attacks`: 55 casos. 42 resistiram. Três mostram limites conhecidos, descritos em `references/limites.md`: dá para achar por força bruta um segundo pedido com a mesma frase, uma segunda rota na mesma origem usa a conexão, e um envelope falso é aceito até o verdadeiro chegar. Uma fraqueza fica como está: quem consegue editar o `ledger.json` do helper reabre um pedido por até 10 minutos, e quem tem esse acesso já lê os arquivos de chave. O restante são observações sem falha.
- `MEASURED.md`: sete rodadas de medição que sustentam o desenho (validade das chaves, cascata de revogação, escopo de sessões e agentes, saída do CLI).

Não foi exercitado: `ssh` e `sshd` de verdade, um `ravi` instalado numa VPS, o daemon e o socket dele, o Chrome comum com o aviso de rede local, o Pages real servindo a rota `/_link/<código>`, NATS e o agente no WhatsApp ou no Slack. O primeiro teste do dono cobre esses pontos.

## Rodar os testes automáticos

Precisam de `bun`, `node` e Playwright com Chromium. Cada processo do Ravi roda com `RAVI_STATE_DIR` isolado numa pasta temporária; nada toca `~/.ravi`. Rode numa máquina de desenvolvimento, não num host de produção: os testes sobem processos do código do gateway a partir do fonte.

```bash
bun install                              # na raiz do repositório, uma vez
design/ravi-connect/test/e2e/run-e2e.sh
node design/ravi-connect/test/attacks/run-all.cjs
```

## Limites que valem lembrar

- Todas as rotas de um projeto do Pages dividem a mesma origem. Use um projeto só para isto.
- A aprovação é imposta pela skill e pelo helper, não pelo gateway.
- Só Chrome no computador.
- O teto é a chave admin: 90 dias, e a rotação dela derruba as conexões.

A lista completa está em `references/limites.md`; o caminho para tirar esses limites, em `PEDIDO-LUIS.md`.

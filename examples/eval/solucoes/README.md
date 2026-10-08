# Eval das skills de soluções

Mede se a skill `solucoes`, as skills `bases`, `pages` e `triggers` reescritas e a seção "Building Solutions" do prompt fazem o agente montar soluções certas com Bases, Pages e o resto do Ravi. Rode primeiro o braço A0, a linha de base (B0): sem ela, nenhum braço prova que ajudou.

Os caminhos deste README são relativos à raiz do repo. As skills ficam em `src/plugins/internal/ravi-system/skills/`.

| Arquivo | O que tem |
|---|---|
| `prompts.md` | os 23 prompts com o texto exato, os itens da rubrica que se aplicam e de 3 a 5 pontos esperados |
| `rubrica.md` | R1–R8, P1–P5 e N; matriz de aplicabilidade; prompt do juiz; vitória e escalada |
| `specs/<id>.json` | um spec de `ravi eval run` por prompt (T1–T5, H01–H14, N1–N4) |
| `checar-comandos.sh` | confere todo `ravi ...` citado numa pasta de skills ou numa transcrição; dá a linha do tempo de P1, P2 e N |

Nada desta pasta entra em skill, em `references/casos.md` da `solucoes` ou em exemplo. Os H01–H14 são reservados: se vazarem, o eval passa a medir memória, não a gramática.

## Braços

| Braço | O que roda | Para quê |
|---|---|---|
| A0 · atual | daemon no `dev` de antes deste PR (o merge-base do branch) | linha de base (B0) |
| A2 · novo | daemon com este PR: `solucoes` no baseline, skills reescritas, seção "Building Solutions" e linha de Routing no prompt, rodapé do gate, `skills show --file`, recusa de `ravi.bases.*` em rota pública no `pages ship` e aviso de `--idempotency-key` ausente | comparação principal contra A0 |
| A2c · curta (opcional) | igual ao A2, mas a seção só com o cabeçalho e o 1º parágrafo, sem a frase final, sem as regras 1–8 e sem a linha de ousadia (≈ 0,4 KB). Exige editar o texto da seção num checkout local | só haiku; diz se a seção curta basta |
| A1 · texto (opcional) | `dev` de antes do PR com só o texto deste PR (skills e `AGENTS.md`) e `solucoes` concedida com `ravi skills grant` | diagnóstico: o texto sozinho ajuda? |

- **Um daemon por braço.** Skills e prompt vêm do checkout que o daemon roda. Rode um daemon por ref, ou monte um sandbox por ref: `ravi sandbox template build ravi-a2 --ref <ref>` e `ravi sandbox run --template ravi-a2 --repo <repo> --task "<rode os specs>"`.
- **O A2 já traz redes de CLI**, não só texto: a recusa do `pages ship` e o aviso de chave. A diferença A0 → A2 mede os dois juntos; para separar o texto, rode o A1.
- **A1 na prática:** num checkout do merge-base, `git checkout <branch-do-PR> -- src/plugins/internal/ravi-system/skills AGENTS.md`, depois `bun run build` e `ravi daemon restart`. O CLI continua o de antes: o texto cita `ravi skills show <skill> --file <path>` e `ravi pages ship --members-best-effort`, que lá não existem. Leia o A1 só como diagnóstico.
- **Atalho para testar só `solucoes` no A0** (não substitui o A1): `ravi skills install solucoes --source <checkout-deste-PR>/src/plugins/internal/ravi-system/skills/solucoes` e depois `ravi skills grant <agente> <nome que ravi skills list --installed mostrar>`.
- **Gates por intenção** (opcional, no A2): os comandos da seção "Gates Por Intenção" de `ravi skills show skill-gates`. Só num agente que já tem `solucoes` autorizada: o gate bloqueia quando a skill-alvo não está liberada.

## Modelos e rodadas

- **haiku** é o leitor principal; **sonnet** é o controle contra regressão. Se o haiku acerta, o resto acerta.
- **Etapa P (plano):** um turno por rodada. 3 rodadas por prompt e braço no haiku, 2 no sonnet. A0 e A2 dão 138 rodadas no haiku e 92 no sonnet; A1 e A2c somam cerca de 140 só no haiku.
- **Etapa C (construção):** só T1–T5, H07, H12 e H14; uma rodada por prompt, braço (A0, A2) e modelo.
- Opus, Codex, Pi e Grok reais entram quando houver máquina, só em A0 e A2.

## Agente de teste

Um agente configurado por braço e modelo. Precisa ser configurado (não grandfather): o agente sem configuração vê todas as skills e o baseline não é medido.

```bash
ravi agents create eval-a0-haiku /srv/eval/a0-haiku
ravi agents set eval-a0-haiku model haiku
ravi agents permissions eval-a0-haiku full-access --execute
ravi cloud scope set --project <projeto-de-staging> --agent eval-a0-haiku
ravi skills who --agent eval-a0-haiku --json
```

- O `cwd` começa vazio, sem notas sobre os prompts.
- O escopo aponta para um projeto de staging também na etapa P. Assim, se o agente criar algo sem mostrar a ficha, o estrago fica no staging, e o P2 registra a falha.
- O último comando mostra o que o agente recebeu. No A0, `solucoes` não aparece; no A2, aparece (no A1, só depois do `ravi skills grant`).

## Como rodar a etapa P

Cada spec já vem com `session.name` e `session.agentId` do A0 haiku, rodada 1. O `ravi eval run` reaproveita a sessão pelo nome, então cada rodada precisa de um nome novo, ou uma rodada contamina a outra. Gere uma cópia por rodada, a partir da raiz do repo:

```bash
BRACO=a0; MODELO=haiku; RODADAS=3
mkdir -p /tmp/eval-rodadas
for id in T1 T2 T3 T4 T5 H01 H02 H03 H04 H05 H06 H07 H08 H09 H10 H11 H12 H13 H14 N1 N2 N3 N4; do
  for n in $(seq 1 $RODADAS); do
    s="eval-$id-$BRACO-$MODELO-$n"
    jq --arg s "$s" --arg a "eval-$BRACO-$MODELO" '.session = {name: $s, agentId: $a}' \
      examples/eval/solucoes/specs/$id.json > /tmp/eval-rodadas/$s.json
    ravi eval run /tmp/eval-rodadas/$s.json --json --output ~/.ravi/evals/skills-solucoes/$s \
      > /tmp/eval-rodadas/$s.out.json
  done
done
```

- O `ravi eval run` sai com 1 quando a rubrica reprova ou o turno falha, é interrompido ou estoura o tempo, sempre depois de imprimir o resultado. Por isso o laço não usa `set -e`. Esse código só vale no terminal do host: chamado de dentro de uma sessão (pelo gateway), sai com 0, e aí valem `grade.pass` e `execution.state` do JSON.
- Cada rodada deixa em `--output`: `run.json`, `after.json` (com `transcript.path`), `grade.json` e `execution.json`.

**Preparo dos negativos:**
- N1: uma base `chamados` no staging, com 2 ou 3 linhas em `Novo`.
- N2: um `sobre.html` no `cwd` do agente, porque o prompt diz "esse HTML". Se o agente perguntar qual arquivo, também passa, desde que sem ficha.
- N4: uma rota `/relatorio` já publicada. Por exemplo: `ravi pages ship --project <p> --title "Relatório" --route /relatorio --body "<h1>Relatório</h1>" --json` e depois `ravi pages visibility <site> public --route /relatorio --execute`.

## O que cada rodada produz

1. **Critérios do spec**, no `grade`. São atalhos baratos:
   - `P2-ficha` (`FICHA` na resposta) e `R1-pessoas` (`Pessoas:` na resposta). Só os braços com `solucoes` usam esse formato. No A0, servem para ver se o formato aparece, não para comparar braços.
   - Um atalho por armadilha em 11 prompts, por exemplo `--expected-version` em T1, H07 e H14, ou `actor.type` em T3 e H03. Esses valem em qualquer braço.
   - Nos negativos, um atalho fraco de "fez a coisa"; N e P3 saem do juiz e do script.
2. **Linha do tempo e P3:** `examples/eval/solucoes/checar-comandos.sh --ordem ~/.ravi/evals/skills-solucoes/<sessão>/after.json`. Mostra, em ordem, as skills abertas, os comandos rodados (com as mutações marcadas) e onde a FICHA apareceu. Dá vereditos auxiliares de P1, P2 e N e lista os comandos e flags que não existem, inclusive os só citados no texto.
3. **Nota do juiz:** R1–R8, P1–P5 e N pela `rubrica.md`.

O script não precisa de daemon nem de `node_modules`, só de `python3`. Lê o registro de comandos de `src/cli/commands/*.ts` do checkout onde ele está. Para conferir contra outro checkout, passe `--src <checkout>` ou `$RAVI_SRC`: rodadas do A0 se conferem contra o checkout do A0, porque um comando que só existe depois deste PR não existia para aquele agente. Com `--help-mode`, usa `ravi ... --help` do `ravi` no PATH.

## Juiz e calibração

- **Juiz:** opus, com o prompt de `rubrica.md`, uma chamada por rodada.
- **Entrada do juiz:**
  - o prompt;
  - os itens que se aplicam (da matriz);
  - os pontos esperados de `prompts.md`;
  - a resposta (`execution.responseText`);
  - a linha do tempo e a lista de comandos inexistentes do script.
- **Cego ao braço.** Troque o nome da sessão por um id opaco e tire braço, modelo e caminhos. Embaralhe a ordem das rodadas antes de mandar.
- **Calibração:**
  - Sorteie 10% das rodadas, estratificadas por prompt.
  - Uma pessoa corrige essas rodadas sem ver a nota do juiz.
  - Se a concordância de um item ficar abaixo de 85%, reescreva o "passa quando" desse item e corrija de novo todas as rodadas. Senão, o desvio do juiz vira resultado.
- **Nota da rodada:** itens aprovados ÷ itens que se aplicam. A comparação entre braços usa a taxa por item e a média de R1–R8 (critérios em `rubrica.md`, "Vitória").

## Etapa C

1. Rode a etapa P com o mesmo prompt.
2. Na mesma sessão, mande um segundo turno pedindo para construir: `jq '.id += "-C" | .prompt = "Pode construir tudo agora." | .runner.timeoutMs = 600000'` sobre a cópia da rodada, com o mesmo `session.name`.
3. Confira o estado final:
   - `ravi pages published --project <p> --json`: rotas e visibilidade;
   - `ravi bases views show <base> <view> --json`: filtro e principals;
   - `ravi triggers show <id>`: filtro, cooldown e prompt;
   - `ravi bases rows history <base> <linha> --json`: chaves e versões.
4. Teste pelo caminho real: abra a página como membro, crie uma linha e veja a reação. `views query` com `$viewer` mostra só as linhas de quem roda, então não serve de prova.
5. Limpe o staging entre rodadas.

## Limites do harness de hoje (lidos em `src/eval/`)

- **O que `transcript.contains` vê.** Só texto de usuário e de assistente depois do prompt; chamadas e saídas de ferramenta ficam de fora (`extractNormalizedTranscriptMessages`). Por isso "abriu `solucoes`" (P1) não vira critério de spec: um `ravi skills show solucoes` rodado pelo Bash nunca casaria. O P1 sai do `checar-comandos.sh --ordem`, que lê o JSONL cru.
- **Sem critério negativo.** O schema não tem "não contém". "Sem FICHA" nos negativos sai do script e do juiz.
- **Sessão nova precisa de dono.** O spec leva `session.agentId`; sem ele, o runner falha ao criar a sessão nova de cada rodada.
- **Specs validados no CI.** `bun test src/cli/commands/eval.test.ts` carrega todo `examples/eval/**/*.json` com o `EvalTaskSpecSchema` estrito de `src/eval/spec.ts`. Uma cópia gerada pelo `jq` do laço passa pelo mesmo schema quando o `ravi eval run` a carrega.

## Contaminação

Antes de cada braço, confira que nenhum domínio reservado entrou nas skills. Revise cada linha que o grep devolver: uma palavra solta em outro sentido pode ficar (como "coordenação entre sessões"), mas um exemplo no domínio de um prompt sai.

```bash
grep -rniE "clínica|vendedor|compra acima|bolão|escola de idiomas|professor|coordenaç|condomínio|morador|assistência técnica|cancelamento|restaurante|reserva de mesa|satisfação|NPS|técnicos? de campo|nota fiscal|plantão|enfermeir|notebook|lista de espera" src/plugins/internal/ravi-system/skills/
examples/eval/solucoes/checar-comandos.sh src/plugins/internal/ravi-system/skills/
```

O checador também acusa comandos inexistentes em skills fora deste eval. Para o eval, valem os achados em `solucoes`, `bases`, `pages`, `triggers`, `automation-recipes`, `crm`, `architect` e `skill-gates`.

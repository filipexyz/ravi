# Prova local de descoberta nativa

Data: 2026-09-10. Escopo: diagnóstico, sem alterações nos adapters ou na VPS.

## Codex: resultado reprovado

O binário local `codex-cli 0.154.0` foi executado em dois processos novos, com `CODEX_HOME` exclusivo de fixture, ambiente sem credenciais e plugins/apps desabilitados. O processo confirmou por `config/read` o valor `false` no baseline e `true` no caso `features.skip_host_skill_discovery`.

Cada processo fez uma chamada ao endpoint HTTP sintético em `127.0.0.1`. O endpoint capturou o pedido em memória e devolveu uma resposta SSE terminal fixa. Ambos os turnos terminaram como `completed`; nenhuma chamada possuía cabeçalho Authorization. Não houve chamada a um modelo externo. Conteúdo de prompts e de skills pessoais não foi gravado no relatório nem em artefato da bancada.

| Superfície | Baseline | Flag habilitada |
| --- | --- | --- |
| `skills/list` inicial | 65 entradas | 65 entradas |
| Fixtures de projeto, ancestral e `CODEX_HOME` | 3 presentes | As mesmas 3 presentes |
| Entradas incidentais, por contagem | 62 | 62 |
| Após `skills/extraRoots/set` com raiz selecionada | 66 entradas | 66 entradas |
| Após remover roots extras | 65 entradas | 65 entradas |
| Primeiro corpo enviado ao endpoint sintético | 45.770 caracteres | 45.770 caracteres |
| Fixtures presentes nesse corpo | Projeto, ancestral, usuário e selecionada | As mesmas 4 |
| Outros nomes do inventário encontrados nesse corpo | 61 | 61 |
| `instructionSources` de `thread/start` | Vazio | Vazio |

A flag não restringiu a descoberta nem suprimiu o catálogo no pedido efetivo desse binário. Roots extras acrescentaram skills ao conjunto, sem substituí-lo. `instructionSources` vazio não comprovou ausência de catálogo.

O schema gerado pelo próprio binário exige `extraRoots` em `skills/extraRoots/set`. Seu `SkillsListParams` aceita apenas `cwds` e `forceReload`; `perCwdExtraUserRoots`, citado na documentação consultada, não teve efeito nesta versão.

No Windows, substituir HOME e USERPROFILE no ambiente do processo não substituiu a pasta do usuário usada para `.agents/skills`: a fixture dessa origem não apareceu, e a descoberta ainda encontrou metadados pessoais. Não foram acessadas credenciais do usuário. Esse comportamento impede tratar a substituição dessas variáveis como isolamento suficiente.

Plugins permaneceram desabilitados; sua restrição não foi comprovada por este ensaio. Como origens pessoais e do projeto já escaparam, o caso não satisfaz o contrato mesmo sem esse teste adicional. Não foi testada uma blacklist como garantia de negação por padrão.

Comando: `rtk proxy bun --no-env-file tests/bench/2026-09-10-global-skill-visibility/codex-native-discovery.mjs`. O comando terminou com erro de veredito, conforme os critérios reprovados. Fixtures temporárias foram preservadas para inspeção.

## Consequência para a implementação

A presença da feature no CLI não permite declarar suporte à restrição. O adapter Codex deve recusar a preparação que dependa desse mecanismo até haver alternativa comprovada. O ensaio evitou ativar um filtro aparente que manteria o catálogo original.

Os testes de opções Claude nesta bancada exercitam o provider real com a fronteira do SDK simulada. Eles distinguem o repasse de `skills: []`, a expansão indevida por skills locais e a admissão local explícita. Não são apresentados como prova do catálogo nativo Claude.

Na base inspecionada, `claude-option-contract.test.js` produziu 1 sucesso e 2 falhas esperadas: o conjunto vazio virou `undefined`, e a concessão `fixture-allowed` ganhou indevidamente `fixture-local-denied`. A admissão local explícita permaneceu sem duplicação. Esses testes registram as regressões que a implementação deve corrigir.

## Continuação: overrides por sessão comprovados

Ainda em 2026-09-10, o ensaio `codex-native-discovery.mjs --path-overrides` validou uma alternativa diferente da flag reprovada. `thread/start.config["skills.config"]` recebeu os caminhos absolutos devolvidos pelo inventário, com `enabled: false`, sem escrever a configuração global.

| Configuração da fixture | Paths desabilitados | Catálogo no pedido efetivo | Tamanho do corpo |
| --- | --- | --- | --- |
| Somente fixture selecionada | 65 | 1 entrada, a selecionada | 31.553 caracteres |
| Nenhuma skill nativa | 66 | 0 entradas | 28.402 caracteres |

Cada caso fez uma única chamada HTTP para a fixture loopback, sem Authorization, e terminou como `completed`. A contagem considera linhas do catálogo; ocorrências incidentais de palavras nas instruções gerais não são entradas de skill. `skills/list` continuou descrevendo o inventário do processo, não a configuração particular do thread.

O adapter adotou o modo textual: o core anuncia o snapshot e o Codex desabilita o inventário nativo inteiro. Uma lista estática de paths não basta. A guarda verifica o snapshot e a revisão nativa antes de cada pedido HTTP, inclusive continuações após resultados de ferramenta. A bancada `codex-adapter-fence.test.ts` comprovou o bloqueio entre turnos e dentro do mesmo turno, usando resultado de ferramenta inexistente e resposta sintética, sem executar ferramentas reais. O ensaio não comprova isolamento do sistema operacional contra um escritor concorrente no filesystem.

## Incidente causado pelo primeiro teste RED do adapter

Em 2026-09-10, o primeiro RED de `codex-skill-exposure.test.ts` chamou a implementação antiga sem isolar o home do processo. Quatro chamadas de preparação alcançaram `ensureCodexBashHookConfig()` sem diretório explícito. Uma delas também chamou `syncCodexSkills([])` sem diretórios explícitos. Isso violou o limite de não alterar recursos globais.

A primeira rotina pode regravar `hooks.json` global quando o texto calculado difere do existente. A segunda lê o manifest global de materializações, remove diretórios antes gerenciados que não estão no novo conjunto e grava o manifest vazio. Nenhuma dessas rotinas guarda pré-imagem. Portanto, o teste por si só não permite afirmar quais diretórios existiam nem reconstruir o estado anterior. O responsável pela tarefa foi avisado, a verificação dos alvos foi delegada em modo somente leitura e nenhuma restauração presumida foi feita.

Como correção da bancada, os testes que importam o adapter agora executam em subprocessos com HOME, USERPROFILE, CODEX_HOME, diretório de trabalho e temporários exclusivos. Antes de importar o provider, verificam que `homedir()` aponta para a fixture. O ambiente herdado usa uma lista mínima de variáveis de sistema e não inclui credenciais. Assim, uma futura regressão para a preparação antiga continua contida na fixture. Os diretórios temporários e o diretório `fixture-cwd` do RED original foram preservados.

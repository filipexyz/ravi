# Resultado — prontidão da migração do Jarvis

Data da coleta: 2026-09-10, 19:14:02 UTC. Escopo: leitura remota e testes locais isolados, conforme [cenário](migration-cenario.md).

## Conclusão

A política foi exercitada com metadados reais, mas o catálogo atual ainda não está pronto para ativação sem uma migração explícita de identidade e requisitos. A simulação local preserva apenas `ravi-system:apps`, `ravi-system:commands`, `ravi-system:pages` e `ravi-system:skill-gates`. Ela omite inclusive o conjunto básico `sessions`, `tasks`, `specs` e `skill-creator`, porque cópias instaladas possuem os mesmos aliases.

O comportamento é seguro — concessões e acesso administrativo não contornam requisitos ausentes ou identidades ambíguas —, porém ativá-lo diretamente causaria perda operacional de instruções. Não foram alterados arquivos, permissões, processos ou concessões na VPS.

## Evidência atual, distinta do incidente histórico

A [fixture sanitizada](../../fixtures/jarvis-skill-migration-2026-09-10.json) contém os conjuntos nominais, origens e hashes. As contagens abaixo descrevem somente essa captura; não são regras de negócio nem expectativas fixas de tamanho de catálogo.

| Fonte | Observação |
| --- | --- |
| Configuração persistida do Jarvis | Perfil `full-access`, 75 capacidades explícitas, incluindo `execute:group:*` e `execute:executable:*`. |
| Concessões de skills | 62 referências nominais. Nenhuma ficou desconhecida na resolução da fixture; referência conhecida não implica exposição. |
| Materialização local da configuração capturada | Autoridade `admin:system:*`; grupos nominais `*`, `doctor`, `self`, `sessions`, `skills`, `specs`, `tasks`. |
| Contextos persistidos do Jarvis | Nenhum registro encontrado. Não foi criada nem presumida uma autoridade de turno real. |
| Catálogo de origem lido | 259 entradas: 45 internas, 206 de plugins de usuário e 8 do workspace. Nenhuma declara `ravi.requires`. |
| Inventário em `/home/ravi/.codex/skills` | 259 entradas de disco. Isso não comprova quais foram efetivamente anunciadas ao modelo. |

Os números históricos de 19 concessões, 14 capacidades explícitas, 41 efetivas, 9 grupos e 219 anúncios não descrevem esta captura. Não havia uma captura nominal histórica verificável disponível nesta subtarefa; portanto não foi fabricada uma regressão que pretendesse reproduzi-la.

## Procedência e limites de autoridade

Os processos RAVI encontrados usam o bundle em `/home/ravi/.nvm/versions/node/v22.22.2/lib/node_modules/ravi.bot` e mantêm aberto `/home/ravi/.ravi/ravi.db`, o banco consultado. O pacote desse caminho e o pacote em `/home/ravi/.bun/install/global/node_modules/ravi.bot` são diretórios distintos, ambos versão `3.260907.1`, com o mesmo SHA-256 de `dist/bundle/index.js`:

`033bd498932bc77812fb6da4b77d85b9340744c92dc21bc038a1cc378b63e842`

O pacote não informa `gitHead`. O hash do bundle identifica o artefato observado, mas não prova que ele foi construído do fork `99f66` ou da base oficial `8fb9099742ee2164582aa7f3811656ab68b71497`, usada pelo worktree. Não se pode preparar substituição ou retorno assumindo equivalência entre essas árvores. A comparação completa de diferenças do fork e a procedência do artefato de release continuam pendentes antes de qualquer ativação.

Para a materialização usada na fixture, os conteúdos de `runtime-bootstrap-provider.ts`, `agent-default-capabilities-provider.ts` e `provider-registry.ts` extraídos do sourcemap remoto foram comparados com os arquivos locais: os três hashes coincidem após normalizar CRLF para LF em UTF-8. Essa prova é limitada a esses arquivos, não à totalidade do runtime.

A [sonda somente leitura](jarvis-readonly-probe.mjs) lê JSON/Markdown locais no host e executa exclusivamente `SELECT` via `sqlite3 -readonly`. Ela não importa nem inicia o RAVI e não lê credenciais, chaves de contexto, conversas ou logs. A skill de acesso cita Docker como regra antiga; esta inspeção seguiu o processo vivo e seus descritores, sem alterar infraestrutura. O RTK não estava instalado no host remoto; foi usado localmente no transporte SSH.

## Lacunas de migração

Os requisitos de 29 skills internas são fornecidos pela migração explícita por grupo. As outras 16 permanecem sem classificação: `ravi-dev:{app-creator,cli-creator,prompt-builder,ravi-architecture,ravi-rules}` e `ravi-system:{architect,automation-recipes,channels-manager,crm-manager,cross-manager,matrix-manager,meetings,observers,slack,tag-rules,tasks-manager}`. `tasks-manager`, `cross-manager` e `matrix-manager` têm semântica legada ou retirada e precisam ser tratados como tal; não há justificativa para declará-los independentes apenas para recuperar uma contagem.

Todas as 214 entradas externas ou locais também estão sem requisitos declarados. A classificação ausente e a colisão de aliases são categorias sobrepostas: não se devem somar suas contagens como exclusões distintas.

A [relação de aliases ambíguos](jarvis-migration-aliases.json) identifica 29 aliases compartilhados por 58 IDs canônicos, principalmente cópias internas em `ravi-user-skills`. Trocar apenas grants por IDs canônicos não resolve a colisão global enquanto ambas as fontes preservarem o mesmo alias. A migração deve decidir a identidade e a origem autoritativa, preservar arquivos pessoais e histórico e classificar requisitos reais; esta entrega não tomou essas decisões sobre dados de produção.

Foi corrigido um defeito estritamente local na declaração de migração do WhatsApp: o registry oferece `whatsapp.dm` e `whatsapp.group`, não `whatsapp`. A skill agora declara esses dois filhos como alternativas explícitas. Não foi criada capacidade fictícia para o grupo pai. A correção não remove a ambiguidade das cópias existentes.

## Verificação local

O teste `src/runtime/skill-policy-jarvis-migration.test.ts` reconstrói apenas metadados externos sanitizados num diretório temporário; os conteúdos remotos não são copiados. Ele usa o catálogo interno local, a configuração/concessões capturadas e um contexto de executor simulado com `exec.shell` e `fs.read`. Isso não é uma afirmação sobre a autoridade ou descoberta de uma sessão ativa da VPS.

| Caso | Resultado |
| --- | --- |
| Configuração capturada materializa perfil administrativo e grupos nominais esperados | PASS. |
| Grants e administração não liberam requisitos ausentes ou aliases ambíguos | PASS; conjunto exato de quatro IDs descrito na conclusão. |
| Leitura real dos `SKILL.md` materializados coincide com o snapshot | PASS; inserir uma skill omitida na evidência é recusado. |
| Remover toda a superfície declarada | PASS; snapshot vazio e anúncio anterior recusado. |
| WhatsApp com permissão apenas `whatsapp.dm` ou apenas `whatsapp.group`, sem grupo raiz registrado | RED antes da correção; GREEN depois, incluindo negação de permissão e ausência de transporte. |

Comandos executados no worktree:

```text
rtk proxy bun test src/runtime/skill-policy-runtime.test.ts src/runtime/skill-policy-catalog.test.ts src/runtime/skill-policy-jarvis-migration.test.ts --timeout 30000
rtk proxy bun test src/runtime/skill-policy-jarvis-migration.test.ts --timeout 30000
rtk proxy bunx biome check src/runtime/skill-policy-runtime.test.ts src/runtime/skill-policy-catalog.ts src/runtime/skill-policy-jarvis-migration.test.ts
rtk proxy node --check tests/bench/2026-09-10-global-skill-visibility/jarvis-readonly-probe.mjs
rtk proxy bunx tsc --noEmit --pretty false
```

A execução combinada passou 45 testes e 122 verificações. A asserção adicional dos grupos materiais foi então incluída: a reexecução final da fixture passou 4 testes e 15 verificações. O Biome, a verificação sintática da sonda e a revalidação global `tsc --noEmit --pretty false` terminaram com código zero. O atributo de importação JSON desta fixture foi corrigido após a primeira checagem de tipos; o trabalho paralelo também resolveu a declaração de `modelCallFence` que bloqueava aquela execução inicial.

## Gate de ativação

Antes de considerar a migração operacionalmente pronta: classificar as skills concedidas que devem continuar disponíveis, resolver colisões preservando os dados existentes, revisar quais legados devem permanecer ocultos e repetir a comparação de conjuntos. Depois, obter autoridade real de uma execução e comprovar descoberta efetiva pelo adapter, além de fechar a procedência do artefato e o plano de retorno. Não houve medição de CPU ou latência, publicação, commit, deploy ou concessão nova nesta subtarefa.

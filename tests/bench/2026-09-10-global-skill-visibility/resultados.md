# Resultados — visibilidade global de skills

## Estado da entrega

Implementação em andamento. Nenhum deploy foi executado. As evidências abaixo são de componentes e integrações locais; não constituem aceite da spec inteira.

## Regressões observadas antes da correção

| Caso | Comportamento anterior | Evidência após ajuste |
| --- | --- | --- |
| Filtro explicitamente vazio | Uma skill privada era anunciada | Teste `an explicit empty policy exposes no plugin skills` passou |
| Adapter sem contrato | Registro aceitava o adapter | Teste `rejects registration without a restrictive skill exposure contract` passou |
| Validação assíncrona no gerador | Mensagem era entregue antes da validação | Teste `waits for asynchronous policy validation before delivering a reused-session turn` passou |
| Preparação central | Contrato ainda não implementado: três testes falharam | Quatro testes de preparação passaram, incluindo recusa de conjunto ampliado e de adapter incompatível |
| Descoberta de fontes | Contrato ainda não implementado: dois testes falharam | Dois testes passaram sem materializar plugins ou esconder erro de descoberta |

## Integrações verificadas pelo agente principal

- `rtk bun test src/runtime/skill-exposure-preparation.test.ts src/runtime/skill-exposure.test.ts`: 6 testes passaram, 9 asserções.
- `rtk bun test src/plugins/skill-source-discovery.test.ts`: 2 testes passaram, 4 asserções.
- `rtk bun test src/runtime/runtime-provider-bootstrap.skill-policy.test.ts`: 2 testes passaram, 9 asserções. Exercita DB isolado, binding persistido, snapshot vazio e invalidação após revogar concessão.
- `rtk bun test src/runtime/delivery-queue.test.ts --test-name-pattern 'asynchronous policy'`: regressão da barreira assíncrona passou depois de falhar no comportamento anterior.

Os testes adicionais de política, materialização, permissões, gates, CLI, adapters e proxy estão em desenvolvimento ou revisão. A execução consolidada será registrada quando a integração estiver estável. Uma verificação global de tipos durante a implementação encontrou um teste novo cujo módulo ainda não havia sido implementado; não há declaração de typecheck final nesta etapa.

## Descoberta nativa

A prova Codex com endpoint sintético mostrou que a flag candidata não elimina o catálogo. Restrições por caminho na configuração da sessão produziram catálogo vazio ou somente a skill selecionada. Isso prova a preparação daquela sessão, não dispensa revalidar mudanças no universo de descoberta antes de cada encaminhamento ao modelo.

No Claude, inventários `supportedCommands` e `reloadSkills` não representam o filtro do contexto principal. A prova nativa de `getContextUsage` antes do prompt distinguiu vazio e conjunto selecionado. Esses limites estão registrados nos artefatos de descoberta desta bancada.

## Guarda por requisição

Critérios adicionais registrados antes da integração: o upstream sintético deve receber somente a primeira chamada quando a política muda antes da segunda; retries e falhas de verificação não podem encaminhar outra chamada. Bindings concorrentes são independentes. Rotas e métodos são explícitos, redirects não podem escapar da guarda, SSE deve preservar streaming e cancelamento deve encerrar a requisição upstream.

## Pendências de aceite

Ainda faltam integração completa do lifecycle, cobertura dos caminhos de autenticação e inferência suportados, revisão final das superfícies, execução consolidada, comparação com o estado da VPS, reconciliação do artefato com o código implantado e empacotamento. O procedimento de retorno e a autorização de deploy permanecem separados.

Há risco conhecido de possível exposição de credenciais em um log inicial de teste. O usuário foi informado e a fixture foi corrigida; consultar o postmortem correspondente. Nenhum segredo integra os resultados versionáveis.

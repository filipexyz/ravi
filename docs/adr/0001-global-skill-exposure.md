# ADR-0001 — Política global de exposição de skills

Data: 2026-09-10
Estado: direção aceita; implementação e validação em andamento.

## Contexto

A aplicação da seleção de skills dependia de cada adapter. Uma execução restrita podia receber metadados de skills não selecionadas, tanto por sincronização ampla quanto pela descoberta nativa. A solicitação é tornar a condição global e extensível a adapters futuros.

## Decisão

O núcleo resolve elegibilidade, identidade e requisitos de ferramentas antes de qualquer preparação. Adapters recebem um snapshot imutável e recursos autorizados. A adesão ao contrato é obrigatória; falta de mecanismo comprovado de restrição resulta em recusa antes do envio ao modelo.

Disponibilidade de ferramenta e autorização são verificadas separadamente. Concessões, baseline e origem local não dispensam requisitos. Metadados legados são migrados apenas a partir de relações já declaradas no registro; ausência de requisitos não significa independência.

Uma preparação é identificada pelo snapshot e não apenas pelo diretório de trabalho. O catálogo observado precisa ser comparado ao autorizado. Inventários do SDK não são tratados automaticamente como prova do contexto entregue ao modelo.

Revalidação por turno não garante revalidação de chamadas internas do SDK. Para transportes opacos, uma guarda por requisição HTTP deve impedir o encaminhamento quando a política mudar; uma rota não coberta permanece incompatível. Reconstrução preserva registros canônicos e não autoriza repetir efeitos concluídos ou de resultado incerto.

## Alternativas

Corrigir somente o Codex deixa a regra vulnerável à implementação dos adapters seguintes. Um helper opcional mantém a mesma fragilidade. Filtrar apenas texto também não controla descoberta nativa, plugins e materializações. Por isso, a política e a validação de conformidade pertencem ao núcleo.

## Consequências

Há custo de classificação de skills antigas, preparação isolada e compatibilidade dos SDKs. Recursos nativos sem restrição comprovada podem ser recusados; delegação pelo RAVI continua sujeita a um novo contexto e snapshot. Não se promete redução da latência total apenas com a redução do catálogo.

## Evidência e ativação

Os critérios anteriores à execução estão na bancada `tests/bench/2026-09-10-global-skill-visibility/cenario.md`. Resultados parciais não autorizam ativação. Artefato, revisão de compatibilidade e procedimento de retorno precisam estar prontos antes da autorização separada de deploy.

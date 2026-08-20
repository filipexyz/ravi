# CRM Agent-First

Pacote de implementação do domínio CRM agent-first para o Ravi.

Este pacote transforma a análise publicada em mudanças no próprio domínio CRM. Não cria outro domínio, outro banco ou uma segunda superfície de dados.

## Escopo

- corrigir filtros e erros das operações CRM existentes;
- publicar contratos de estado, saída e ciclo de vida;
- adicionar a camada de intenção, plano, aplicação, verificação e recuperação;
- preservar compatibilidade durante a migração dos consumidores;
- regenerar os contratos públicos derivados do registro do Ravi.

## Regra de execução

Os testes serão escritos neste branch, mas não serão executados localmente. Build, typecheck, testes, geração e drift checks serão validados pelo CI do PR.

Nenhum teste de escrita será feito na VPS durante o desenvolvimento. A implantação só poderá usar o commit mesclado e aprovado.

## Documentos

- [Plano de implementação](PLAN.md)
- [Rastreabilidade](traceability.md)
- [Descrição do PR](../../pr/crm-agent-first.md)

# Bancada — visibilidade global de skills

## Objetivo e escopo

Validar a implementação da spec `2026-09-10-visibilidade-global-de-skills.md`, preparada em `Desktop/RAVI/specs`, sem ativar mudanças na VPS. A base é o commit `8fb9099742ee2164582aa7f3811656ab68b71497` do RAVI. Código de produção, dados pessoais e permissões da VPS não são alvos dos testes.

Esta matriz é registrada antes da execução. O commit do registro e a publicação ficam pendentes de autorização; resultados não podem modificar retroativamente os critérios.

## Critérios de aceite

1. A política central usa identidade canônica e seleciona baseline, capacidades, concessões e admissões locais, sempre verificando requisitos.
2. Requisitos distinguem independência explícita, AND, OR, ausência e erro. Disponibilidade e autorização são condições separadas.
3. Ausência de configuração, concessões vazias e snapshot vazio nunca liberam o catálogo inteiro.
4. O contrato do adapter é validado antes de preparar uma sessão ou chamar o modelo. Um adapter fictício funciona sem alterações por nome no núcleo; um incapaz de restringir descoberta é recusado.
5. O conjunto efetivamente descobrível não excede o snapshot. Catálogos nativo e textual não duplicam o mesmo anúncio.
6. Materializações de agentes distintos são isoladas e imutáveis. Arquivos pessoais não são apagados nem admitidos implicitamente.
7. Revisões de identidade, permissões, concessões, catálogo e superfície de ferramentas são verificadas antes das chamadas. Revogação não reutiliza contexto contaminado nem repete efeitos já concluídos.
8. Descoberta, leitura e gates de skills do RAVI usam a mesma política. A autorização de ferramentas continua independente.
9. A regressão do Jarvis compara conjuntos autorizados e expostos, não constantes de contagem do incidente.
10. Telemetria diferencia resolução, preparação e exposição observada, sem conteúdo de skills, conversas ou credenciais.

## Execução

Componente determinístico: uma execução por caso, seguida de estresse com IDs ambíguos, entradas inválidas, caminhos locais, concorrência e revogação. Usar fixtures reais de arquivos e catálogos; simular somente transportes externos quando necessário.

Capturar primeiro o comportamento atual em testes de regressão. Registrar comandos, códigos de saída e resultados em `resultados.md`. Medir tamanho de anúncio e tempo de preparação em condições equivalentes; não inferir ganho de latência total a partir de testes unitários.

## Entrega

Exigir testes direcionados, verificação de tipos, lint dos arquivos alterados, build e revisão independente. Preparar artefato e procedimento de retorno preservando o histórico. Nenhum teste local autoriza deploy nem substitui evidência da descoberta real do adapter.

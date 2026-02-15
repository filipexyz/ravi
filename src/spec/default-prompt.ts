/**
 * Default Spec Mode Prompt
 *
 * Used when no SPEC_INSTRUCTIONS.md is found in the agent's workspace.
 * Can be overridden per-agent by placing a SPEC_INSTRUCTIONS.md in the agent's cwd.
 */

export const DEFAULT_SPEC_PROMPT = `# Spec Mode

Você entrou em **Spec Mode**. Neste modo, seu objetivo é construir uma especificação completa da task antes de implementar qualquer coisa.

## Regras

1. **Não implemente nada** — tools de escrita (Edit, Write, Bash) estão bloqueadas
2. **Explore livremente** — use Read, Glob, Grep, WebFetch, WebSearch para entender o código
3. **Pergunte ao usuário** — use AskUserQuestion ou pergunte diretamente quando tiver dúvidas
4. **Registre progresso** — use \`update_spec\` para registrar o que já sabe e o que falta
5. **Defina o progresso (%)** — você decide o percentual baseado no quanto entende da task

## Barra de Progresso

Sempre que chamar \`update_spec\`, mostre a barra de progresso visualmente na sua resposta:

📋 Spec Mode [========------------ ] 40%

O que eu já sei e o que falta...

Use = para preenchido e - para vazio (20 posições dentro dos colchetes). Isso dá visibilidade ao usuário sobre o quanto você entende da task.

## Como conduzir

1. **Entenda o pedido** — o que o usuário quer? Qual o objetivo final?
2. **Explore o código** — quais arquivos são relevantes? Quais padrões existem?
3. **Identifique incógnitas** — o que você ainda não sabe? Pergunte ao usuário
4. **Registre progresso** — chame \`update_spec\` e mostre a barra de progresso na resposta
5. **Complete a spec** — quando estiver em 100%, chame \`exit_spec_mode\` com a spec final

## Formato da Spec Final

A spec passada para \`exit_spec_mode\` deve conter:

- **Objetivo**: O que será implementado e por quê
- **Requisitos**: Lista clara do que precisa acontecer
- **Arquivos afetados**: Quais arquivos serão criados/modificados
- **Abordagem técnica**: Como será implementado (padrões, libs, etc)
- **Riscos e edge cases**: O que pode dar errado
- **Plano de teste**: Como verificar que funciona

## Dicas de progresso

- 0-20%: Entendeu o pedido básico
- 20-50%: Explorou o código relevante, identificou padrões
- 50-80%: Coletou requisitos do usuário, definiu abordagem
- 80-100%: Spec completa, pronta para aprovação

Essas faixas são apenas referência — você decide o % real baseado no seu entendimento.

## Importante

- O progresso não precisa ser linear — pode pular de 20% pra 60% se o usuário explicar tudo
- Use \`update_spec\` sempre que aprender algo significativo — isso dá visibilidade ao usuário
- Não tenha pressa — uma boa spec evita retrabalho na implementação
`;

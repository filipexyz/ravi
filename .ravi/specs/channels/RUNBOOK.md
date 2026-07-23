# Channels Runbook

## Diagnosticar Inbound

1. Identifique a instância de canal que recebeu o evento.
2. Confirme que o evento carrega conta/instância explícita antes de rotear.
3. Verifique chat, thread, ator e mensagem normalizados.
4. Confirme que a sessão foi escolhida por route/subscription, não por id cru
   de provedor.
5. Preserve ids crus apenas como provenance/debug.

## Diagnosticar Outbound

1. Comece pelo intent do Ravi: sessão, chat/thread alvo, actor e policy.
2. Confirme a capability do canal e da instância antes de renderizar.
3. Resolva credenciais pelo broker/manager quando o adapter precisar falar com
   o provedor.
4. Envie pelo adapter de transporte.
5. Registre delivery state e erros sem imprimir segredo.

## Migração De Adapter

1. Modele o comportamento no spec de `channels` ou sub-spec aplicável.
2. Mantenha compatibilidade com Omni como bridge quando necessário.
3. Não promova env vars a fonte de identidade permanente.
4. Adicione teste focado para a fronteira alterada.
5. Rode o quality gate antes de abrir PR.

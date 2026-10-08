---
name: architect
description: |
  DEPRECADO. O CLI `ravi architect`, o catálogo `.ravi/recipes` e os task profiles architect-* não existem para o agente. Para transformar um pedido em uma solução com primitivas reais, use a skill solucoes (ficha de seis verbos e oito regras).
---

# Architect (deprecado)

- **Não existe:** `ravi architect` nem `.ravi/recipes/`. Comando citado em versões antigas desta skill falha.
- **Profiles antigos não carregam:** `architect-discover`, `architect-plan` e `architect-execute` ficaram em `.ravi/profiles/` do repo do Ravi, que não é fonte de task profiles. `ravi tasks create --profile architect-plan` falha; não use.
- **Para montar uma solução:** `ravi skills show solucoes` (pessoas, ficha de seis verbos, oito regras).

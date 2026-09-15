# App Builder Review Checklist

Use todos os gates. Marque `N/A` somente com justificativa escrita.

## SOURCE_CONTRACT

- [ ] Problema, usuário-alvo e resultado foram definidos.
- [ ] Documentação oficial e versão/data de consulta estão registradas.
- [ ] Recursos, operações, paginação, limites e erros foram mapeados.
- [ ] Operações públicas foram selecionadas por valor e segurança, não por
      espelhamento automático da fonte.

## CLI_BOUNDARY

- [ ] Existe um único CLI de implementação real.
- [ ] `interfaces.cli.command` não aponta para `ravi <app-id>`.
- [ ] Cada operação pública tem JSON estável, exit status e erro tipado.
- [ ] stdout contém dados; stderr contém diagnóstico.
- [ ] Argumentos são argv literal; não há shell, pipes ou redirecionamento.

## AUTHENTICATION

- [ ] Foi escolhida uma fronteira de broker/connector/provider client.
- [ ] Nenhum secret ou secret path aparece em manifesto, argv, output ou docs.
- [ ] Credencial ausente/desabilitada falha antes de rede.
- [ ] Health local não afirma autenticação externa sem prova.
- [ ] Erros do provider são sanitizados.

## PERMISSIONS_CONTEXT

- [ ] Reads sensíveis, writes e destructive têm classes distintas.
- [ ] Mutações possuem permission metadata e confirmação adequada.
- [ ] `context.allow` contém o menor teto necessário ou `[]`.
- [ ] Falha de delegação acontece antes do CLI iniciar.
- [ ] O processo recebe contexto-filho, nunca a chave pai.

## SKILL_VISIBILITY

- [ ] A skill operacional ensina comandos, outputs, riscos e recovery.
- [ ] A skill está indexada no runtime-alvo.
- [ ] Agents com allowlist receberam apenas o grant necessário.

## OPTIONAL_SURFACES

- [ ] Storage tem decisão explícita e ownership quando usado.
- [ ] Events têm decisão explícita e schema quando usados.
- [ ] Artifacts têm decisão explícita e provenance quando usados.
- [ ] UI tem decisão explícita e referencia operations declaradas quando usada.

## FUNCTIONAL_VALIDATION

- [ ] Client usa fake HTTP e credencial injetada nos testes.
- [ ] CLI exerce sucesso, input inválido, erro do provider e paginação.
- [ ] `ravi apps check <app-id> --json` passa.
- [ ] `ravi <app-id> <operation> --json` atravessa o router até o fake.
- [ ] Contexto negado e permitido foram exercitados.
- [ ] Não há chamada real, mutation real ou secret real em teste.

## RELEASE

- [ ] Specs e skill refletem o contrato final.
- [ ] Schemas públicos e SDK/OpenAPI foram regenerados e checados.
- [ ] Typecheck, lint/format, testes focados e suíte completa passam.
- [ ] O resultado do scaffold/import e este checklist não apresentam drift.

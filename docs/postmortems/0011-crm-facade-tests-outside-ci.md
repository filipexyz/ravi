# Postmortem 0011: testes da facade CRM fora do CI

## Expectativa

O Quality Gate verde da PR deveria executar os testes semanticos exigidos pela
SPEC da facade CRM.

## Ocorrido

Os testes focados eram executados manualmente e ficavam verdes, mas
`bun run test` nao incluia `src/crm/` nem
`src/contacts.identity-model.test.ts`. Assim, o CI podia passar sem comprovar
o limite de journal, o crash em `applying` e a preservacao real de
`primary`.

## Causa

O gate verificava a presenca de especificacao e cobertura no diff, mas a lista
manual de suites do `package.json` nao acompanhou a criacao da facade. A
evidencia manual foi tratada como suficiente sem confirmar que o caminho
automatico executava os mesmos testes.

## Correcao

- `bun run test` agora executa `src/crm/`;
- a integracao de identidade roda em processo separado para evitar vazamento
  de mocks entre arquivos;
- um subprocesso descartavel comprova a persistencia do estado `applying`;
- a matriz cobre os nove alvos, visibilidade e entradas materiais invalidas.

## Prevencao

Uma capacidade nova so fecha G4 quando seu teste aparece tanto no CHECKS quanto
no comando realmente executado pelo CI. Evidencia manual continua complementar,
nunca substituta do gate automatico.

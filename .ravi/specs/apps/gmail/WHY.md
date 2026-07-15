# Gmail Ravi App / WHY

## Rationale

O repositório já possui uma superfície `ravi gmail` que usa o connector Google
para listar, ler e enviar mensagens. O Ravi App acrescenta um cliente REST
direto para a API oficial sob `--native`, enquanto mantém o connector como
fallback compatível e o SDE como baseline externo intocado.

A alternativa de copiar `gmail.service.ts` foi rejeitada: ela carregaria
aliases organizacionais, arquivos de token e lógica de autenticação legada.
Também não se criam capabilities novas no Link: o app usa `GmailClient` direto,
com credencial resolvida pelo broker e transporte injetável. Só list/read/send
entram no manifesto inicial; o restante fica mapeado para implementação
incremental.

# Long tool detachment

## Tese

O turno prendia em qualquer comando longo que não se declarasse longo. A promoção
antiga (`src/jobs/promotion.ts`) decidia **antes** de o comando rodar, olhando
sintaxe: `timeout` alto, `sleep` longo, `nohup ... & wait`. Os comandos que de
fato prendem — `bun test`, `docker build`, deploy, `gh run watch` — não declaram
nada, então rodavam minutos dentro do turno enquanto a sessão parecia morta do
outro lado.

A decisão certa não é sintática, é temporal: o comando vira job **se demorar**.

## Contrato

Toda chamada de Bash é reescrita para um wrapper (`src/jobs/ravi-jobs-exec.sh`,
materializado no state dir em `jobs/ravi-jobs-exec.sh`). O wrapper executa o
comando de verdade como filho e tem dois desfechos:

1. **abaixo do limiar** (padrão 25s): comportamento indistinguível de rodar o
   comando solto — mesma saída, mesmo exit code, nada registrado;
2. **acima do limiar**: registra o job **antes** de sair, devolve um handle
   honesto (handle, não saída) e o comando segue vivo fora do turno. O desfecho
   volta para a sessão quando termina, pelo runner de jobs.

Quem decide autorizar continua sendo o gate de permissão, e ele vê **o comando
original**, nunca o wrapper. A reescrita é aplicada depois da autorização.

## Mecânica

- O comando original viaja citado como um argumento só, depois de `--`: um `&` no
  comando não pode escapar para o shell do provider.
- O runner é iniciado em sessão própria (`setsid`; `perl POSIX::setsid` quando o
  binário não existe, como no macOS). Abort do turno manda sinal para o grupo de
  processos do provider; sem sessão própria, o comando morreria junto.
- O runner é o **dono do pid**: `$!` no wrapper é o subshell de `start_runner`, que
  sai na hora. Por isso o runner publica o próprio pid em `runs/run_*/pid` e o
  wrapper registra esse. Registrar o pid do subshell faz `ravi jobs kill`
  sinalizar um processo morto e deixar o comando destacado órfão.
- O exit code é escrito pelo shell que executou o comando (`<log>.exit`), de forma
  atômica. `pid vivo` não distingue comando terminando de pid reutilizado, e sinal
  não é adivinhável a partir do banco. O runner captura TERM/INT para conseguir
  escrever `128 + n` quando o job é encerrado à força.
- O runner avisa o Ravi (`ravi jobs finish`) quando o job foi destacado; o runner
  de jobs escuta `ravi.jobs.finished`, fecha a linha e entrega o desfecho. O
  reconcile cobre job cujo processo sumiu sem avisar.

## Invariantes

- O handle que o agente recebe aponta para uma linha que já existe no banco.
- Nenhum job nasce com pid de processo que não seja o dono real do comando.
- Entregar o desfecho é idempotente: tópico, reconcile e kill não duplicam.
- Falha do detach nunca derruba a tool call: sem wrapper, o comando roda igual.

## Interruptores

| Variável | Efeito |
| --- | --- |
| `RAVI_JOBS_DETACH=0` | o wrapper roda o comando sem destacar nada |
| `RAVI_JOBS_DETACH_AFTER_MS` | limiar em ms (piso 200) |
| `RAVI_JOBS_WRAP=0` | volta à promoção antiga, por sintaxe |
| `RAVI_JOBS_PROMOTE=0` | não reescreve nada |

#!/bin/sh
###
# ravi-jobs-exec — executa um comando e o destaca como job quando passa do limiar.
#
# Gerado por Ravi (`ravi jobs`). Não editar: a próxima geração sobrescreve.
#
# Por que existe: o turno ficava preso em qualquer comando longo que não se
# declarasse longo. A decisão de destacar era tomada antes do comando rodar, por
# sintaxe (`timeout` alto, `sleep`, `nohup ... & wait`), então `bun test`,
# `docker build`, deploy e `gh run watch` continuavam dentro do turno enquanto a
# sessão parecia morta do outro lado.
#
# Aqui a decisão é tomada pelo relógio, enquanto o comando roda:
#
#   - abaixo do limiar: mesma saída e mesmo exit code de rodar o comando solto;
#   - acima do limiar: registra o job, imprime o handle e sai 0. O comando segue
#     vivo em sessão própria (setsid), fora do grupo de processos do provider, e
#     o desfecho volta para a sessão pelo runner de jobs quando termina.
#
# Contrato:
#   ravi-jobs-exec [--session S] [--agent A] -- <comando>
#   ravi-jobs-exec --__runner <comando> <log> <exit> <detach> <job_file>   (interno)
###

set -u

RAVI_CLI_BIN='@@CLI_BIN@@'
RAVI_CLI_ARG='@@CLI_ARG@@'
DETACH_AFTER_MS_DEFAULT=@@DETACH_AFTER_MS@@

# Um lugar só para chamar o CLI: `ravi jobs register|finish`.
# RAVI_JOBS_CLI (multi-palavra) existe para teste e para operador trocar o CLI.
run_cli() {
  if [ -n "${RAVI_JOBS_CLI:-}" ]; then
    # shellcheck disable=SC2086
    ${RAVI_JOBS_CLI} "$@"
  elif [ -n "$RAVI_CLI_ARG" ]; then
    "$RAVI_CLI_BIN" "$RAVI_CLI_ARG" "$@"
  else
    "$RAVI_CLI_BIN" "$@"
  fi
}

# ------------------------------------------------------------------ runner (interno)
#
# Este é o processo que é pai do comando de verdade. Ele é o único que sabe o
# código de saída, e é ele que continua vivo depois que o wrapper desiste.

if [ "${1:-}" = "--__runner" ]; then
  shift
  runner_command=${1:-}
  runner_log=${2:-/dev/null}
  runner_exit=${3:-/dev/null}
  runner_detach=${4:-/dev/null}
  runner_job_file=${5:-/dev/null}
  runner_pid_file=${6:-/dev/null}

  # Este shell é quem o job deve registrar como pid.
  #
  # `$!` no wrapper é o subshell de `start_runner`, que sai assim que a função
  # termina; o runner de verdade é neto dele. Registrar o pid do subshell faria um
  # `ravi jobs kill` sinalizar um processo morto e o comando destacado continuar
  # vivo — órfão que ninguém mais alcança. Então o runner publica o próprio pid.
  printf '%s\n' "$$" >"$runner_pid_file.part" 2>/dev/null &&
    mv "$runner_pid_file.part" "$runner_pid_file" 2>/dev/null

  # stdin fechado: comando longo não pode ficar esperando terminal.
  #
  # O trap importa: quando o job é encerrado, o sinal vai para o grupo inteiro,
  # este shell incluído. Sem capturar, ele morreria antes de escrever o estado e
  # o desfecho ficaria "killed" sem exit code — justamente o código que o Ravi
  # usa para contar o que aconteceu. Capturado, ele espera o filho terminar e
  # grava `128 + n`, que é o código que o próprio shell reportaria.
  runner_signal=0
  trap 'runner_signal=143' TERM
  trap 'runner_signal=130' INT
  sh -c "$runner_command" </dev/null
  runner_code=$?
  [ "$runner_signal" -ne 0 ] && runner_code=$runner_signal

  # Escrita atômica: quem lê o estado nunca pega um arquivo pela metade.
  printf '%s\n' "$runner_code" >"$runner_exit.part" 2>/dev/null &&
    mv "$runner_exit.part" "$runner_exit" 2>/dev/null

  # Se o wrapper já se comprometeu com o job, este é o processo que avisa o Ravi.
  if [ -e "$runner_detach" ]; then
    runner_job_id=$(cat "$runner_job_file" 2>/dev/null || true)
    if [ -n "$runner_job_id" ]; then
      run_cli jobs finish --id "$runner_job_id" >/dev/null 2>&1 || true
    fi
  fi

  exit "$runner_code"
fi

# ------------------------------------------------------------------ wrapper (turno)

session=''
agent=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session)
      [ "$#" -ge 2 ] || break
      session=$2
      shift 2
      ;;
    --agent)
      [ "$#" -ge 2 ] || break
      agent=$2
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -eq 0 ]; then
  echo "ravi-jobs-exec: nenhum comando para rodar" >&2
  exit 2
fi

if [ "$#" -eq 1 ]; then
  command_text=$1
else
  command_text=$*
fi

if [ -z "$command_text" ]; then
  echo "ravi-jobs-exec: comando vazio" >&2
  exit 2
fi

# Quem chama pode não passar --session/--agent (caminho pi, sem hooks): o env do
# processo do provider já carrega a sessão que precisa receber o desfecho.
[ -n "$session" ] || session=${RAVI_SESSION_NAME:-}
[ -n "$agent" ] || agent=${RAVI_AGENT_ID:-}

# Desligado explicitamente: roda como se o wrapper não existisse.
if [ "${RAVI_JOBS_DETACH:-1}" = "0" ]; then
  exec sh -c "$command_text"
fi

detach_after_ms=${RAVI_JOBS_DETACH_AFTER_MS:-$DETACH_AFTER_MS_DEFAULT}
case "$detach_after_ms" in
  '' | *[!0-9]*) detach_after_ms=$DETACH_AFTER_MS_DEFAULT ;;
esac
[ "$detach_after_ms" -ge 200 ] 2>/dev/null || detach_after_ms=200
threshold=$(printf '%d.%03d' $((detach_after_ms / 1000)) $((detach_after_ms % 1000)))

state_root=${RAVI_STATE_DIR:-${HOME:-/tmp}/.ravi}
run_dir=$state_root/jobs/runs/run_$$_$(date +%s)
if ! mkdir -p "$run_dir" 2>/dev/null; then
  # Sem lugar para registrar o estado, o wrapper não tem como ser honesto.
  exec sh -c "$command_text"
fi
log=$run_dir/log
exit_file=$log.exit
detach_file=$run_dir/detach
job_file=$run_dir/job_id
pid_file=$run_dir/pid
: >"$log" 2>/dev/null || true

start_runner() {
  # setsid importa: abort do turno manda SIGKILL para o grupo de processos
  # inteiro do provider. Sem sessão própria, o comando morreria com o wrapper.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$0" --__runner "$command_text" "$log" "$exit_file" "$detach_file" "$job_file" "$pid_file" </dev/null
  elif command -v perl >/dev/null 2>&1; then
    perl -MPOSIX -e 'POSIX::setsid() >= 0 or exit 111; exec @ARGV or exit 127' -- \
      "$0" --__runner "$command_text" "$log" "$exit_file" "$detach_file" "$job_file" "$pid_file" </dev/null
  else
    # Sem setsid o comando ainda roda; o que se perde é a garantia de sobreviver
    # a um kill do grupo (documentado em design/long-tool-detachment.md).
    "$0" --__runner "$command_text" "$log" "$exit_file" "$detach_file" "$job_file" "$pid_file" </dev/null
  fi
}

wrapper_pid=$$
timer_pid=''
timed_out=0
trap 'timed_out=1' USR1

start_timer() {
  (
    trap 'kill "${timer_sleep:-}" 2>/dev/null; exit 0' TERM
    sleep "$threshold" &
    timer_sleep=$!
    wait "$timer_sleep" 2>/dev/null
    kill -USR1 "$wrapper_pid" 2>/dev/null
  ) &
  timer_pid=$!
}

start_timer
start_runner >>"$log" 2>&1 &
child_pid=$!

# `wait` volta na hora quando o comando termina e também quando o timer interrompe.
wait "$child_pid"
status=$?
kill "$timer_pid" 2>/dev/null || true
timer_pid=''

if [ "$timed_out" -eq 0 ]; then
  # Caminho rápido: indistinguível de rodar o comando solto. O diretório de
  # execução é descartável: nenhum job aponta para ele.
  cat "$log" 2>/dev/null
  rm -rf "$run_dir" 2>/dev/null || true
  exit "$status"
fi

read_exit_file() {
  raw_exit=$(cat "$exit_file" 2>/dev/null || true)
  case "$raw_exit" in
    '' | *[!0-9]*) raw_exit=0 ;;
  esac
  printf '%s' "$raw_exit"
}

# O comando pode ter terminado entre o timer e este ponto. Então não há o que
# destacar: o resultado está no log e o exit code é o do comando.
if [ -s "$exit_file" ]; then
  cat "$log" 2>/dev/null
  rm -rf "$run_dir" 2>/dev/null || true
  exit "$(read_exit_file)"
fi

# Commit: daqui pra frente o comando vive fora do turno.
: >"$detach_file" 2>/dev/null || true
job_id=job_$(date +%s)_$$
printf '%s\n' "$job_id" >"$job_file" 2>/dev/null || true

# Pid do runner (ver o bloco interno). Sem ele, cai no `$!` do subshell: melhor
# um pid aproximado que nenhum, mas o normal é o arquivo já estar lá.
job_pid=$(cat "$pid_file" 2>/dev/null || true)
case "$job_pid" in
  '' | *[!0-9]*) job_pid=$child_pid ;;
esac

# Registra ANTES de sair: o agente só recebe um handle que existe de fato.
run_cli jobs register \
  --id "$job_id" \
  --pid "$job_pid" \
  --log "$log" \
  --command "$command_text" \
  --cwd "$PWD" \
  --session "$session" \
  --agent "$agent" \
  >>"$run_dir/register.log" 2>&1
register_status=$?

if [ -s "$exit_file" ]; then
  # Terminou durante o registro: o resultado é real e pertence a este turno.
  finished_code=$(read_exit_file)
  if [ "$register_status" -eq 0 ]; then
    run_cli jobs finish --id "$job_id" --exit "$finished_code" --silent >/dev/null 2>&1 || true
  fi
  cat "$log" 2>/dev/null
  exit "$finished_code"
fi

if [ "$register_status" -ne 0 ]; then
  # Não mentir: o processo está vivo, mas nenhum job existe para entregar nada.
  cat <<EOF
[detached-untracked] o comando continua rodando, mas o job não foi registrado (exit $register_status).
  log: $log
  parar: kill -TERM -$job_pid
O desfecho não volta para esta sessão automaticamente; use o log.
EOF
  exit 1
fi

seconds=$(printf '%d' $((detach_after_ms / 1000)))
cat <<EOF
[detached] job $job_id — o comando passou de ${seconds}s e continua rodando fora do turno.
Você NÃO tem a saída dele neste retorno.
  log:   $log
  ver:   ravi jobs tail $job_id
  parar: ravi jobs kill $job_id
Não rode o mesmo comando de novo: o desfecho volta para esta sessão quando terminar, e o próximo passo que precisa da saída pertence ao turno seguinte.
EOF
exit 0

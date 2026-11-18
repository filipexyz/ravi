import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { z } from "zod";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import { nats } from "../../nats.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { getContext } from "../context.js";
import { canAccessResource, canModifySession, getScopeContext, isScopeEnforced } from "../../permissions/scope.js";
import {
  dbCreateJob,
  dbFinishJob,
  dbGetJob,
  dbListJobs,
  dbRegisterJob,
  isJobTerminal,
  JOB_FINISHED_TOPIC,
  JOB_KILL_TOPIC,
  JOB_START_TOPIC,
  jobStatusFromExitCode,
  readJobExitState,
  readJobTail,
  signalFromExitCode,
  type JobRecord,
} from "../../jobs/index.js";

const jobSchema = z.object({
  id: z.string(),
  sessionName: z.string().nullable(),
  agentId: z.string().nullable(),
  command: z.string(),
  cwd: z.string().nullable(),
  status: z.string(),
  pid: z.number().nullable(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  logPath: z.string(),
  origin: z.string(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});

const jobsPaginationSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  nextCommand: z.string().nullable(),
});

const jobsListReturnSchema = z.object({
  total: z.number(),
  pagination: jobsPaginationSchema,
  items: z.array(jobSchema),
});

const jobsRunReturnSchema = z.object({
  id: z.string(),
  status: z.string(),
  command: z.string(),
  logPath: z.string(),
  sessionName: z.string().nullable(),
  hint: z.string(),
});

const jobsJobReturnSchema = z.object({ job: jobSchema });

const jobsTailReturnSchema = z.object({
  id: z.string(),
  status: z.string(),
  logPath: z.string(),
  tail: z.string(),
});

const jobsWaitReturnSchema = z.object({
  id: z.string(),
  status: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  logPath: z.string(),
});

const jobsKillReturnSchema = z.object({
  id: z.string(),
  status: z.string(),
  killed: z.boolean(),
});

const jobsRegisterReturnSchema = z.object({
  id: z.string(),
  status: z.string(),
  pid: z.number().nullable(),
  logPath: z.string(),
  origin: z.string(),
});

const jobsFinishReturnSchema = z.object({
  id: z.string(),
  status: z.string(),
  exitCode: z.number().nullable(),
  signal: z.string().nullable(),
  notified: z.boolean(),
});

function serializeJob(job: JobRecord) {
  return {
    id: job.id,
    sessionName: job.sessionName,
    agentId: job.agentId,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    pid: job.pid,
    exitCode: job.exitCode,
    signal: job.signal,
    logPath: job.logPath,
    origin: job.origin,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function resolveSessionName(explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    return getContext()?.sessionName ?? null;
  } catch {
    return null;
  }
}

function resolveAgentId(explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    return getContext()?.agentId ?? null;
  } catch {
    return null;
  }
}

/** Jobs belong to their agent: other agents' jobs read as missing. */
function canUseJob(job: Pick<JobRecord, "agentId">, mode: "read" | "mutate"): boolean {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return true;
  return canAccessResource(scopeCtx, job.agentId ?? undefined, mode);
}

function getUsableJob(id: string, mode: "read" | "mutate"): JobRecord | null {
  const job = dbGetJob(id);
  return job && canUseJob(job, mode) ? job : null;
}

/**
 * A job runs for its agent and reports into its session, so picking another
 * agent or session needs the authority to act there.
 */
function assertJobTargetAuthorized(agentId: string | null, sessionName: string | null): void {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return;
  if (!canAccessResource(scopeCtx, agentId ?? undefined, "mutate")) {
    fail(`Agent not found: ${agentId ?? "(none)"}`);
  }
  if (sessionName && !canModifySession(scopeCtx, sessionName)) {
    fail(`Session not found: ${sessionName}`);
  }
}

/**
 * Jobs: chamada longa fora do turno.
 *
 * O comando roda em background, o agente recebe um id na hora e o desfecho volta
 * para a sessão quando terminar. O turno nunca fica preso, então nada enfileira.
 */
@Group({
  name: "jobs",
  description: "Execução de chamada longa em background, com desfecho entregue na sessão",
})
export class JobsCommands {
  @Command({
    name: "run",
    description: "Start a long command in the background and return immediately",
    helpAfter: `Jobs existem para o turno não bloquear numa chamada longa.

  ravi jobs run --session dev -- bun run test
  ravi jobs run --wait -- ./build.sh        # bloqueia de propósito
  ravi jobs list --session dev
  ravi jobs tail job_abc123 -n 50
  ravi jobs wait job_abc123
  ravi jobs kill job_abc123

O desfecho volta para a sessão automaticamente quando o job termina.`,
  })
  @CommandAccess({ kind: "mutate", resource: "jobs", action: "run", risk: "medium" })
  @Returns(jobsRunReturnSchema)
  async run(
    @Arg("command", { variadic: true, description: "Command to run (after --)" }) command: string[],
    @Option({ flags: "--session <name>", description: "Session to notify when the job finishes" })
    sessionName?: string,
    @Option({ flags: "--agent <id>", description: "Agent that owns the job" }) agentId?: string,
    @Option({ flags: "--cwd <dir>", description: "Working directory" }) cwd?: string,
    @Option({ flags: "--wait", description: "Block until the job finishes, then print the tail" }) wait?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const commandLine = command.join(" ").trim();
    if (!commandLine) {
      fail("jobs run precisa de um comando: ravi jobs run -- <comando>");
      return;
    }

    // Um log por job. Um arquivo compartilhado misturaria saídas de comandos
    // diferentes e o tail perderia sentido.
    const jobSessionName = resolveSessionName(sessionName);
    const jobAgentId = resolveAgentId(agentId);
    assertJobTargetAuthorized(jobAgentId, jobSessionName);

    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const job = dbCreateJob({
      id: jobId,
      sessionName: jobSessionName,
      agentId: jobAgentId,
      command: commandLine,
      cwd: cwd ?? null,
      logPath: join(getRaviStateDir(), "jobs", `${jobId}.log`),
      origin: "cli",
    });

    const result = {
      id: job.id,
      status: job.status,
      command: job.command,
      logPath: job.logPath,
      sessionName: job.sessionName,
      hint: `ravi jobs tail ${job.id}`,
    };

    // Despacha para o daemon: ele é dono do processo.
    try {
      await nats.emit(JOB_START_TOPIC, { jobId: job.id });
    } catch (error) {
      fail(`Não foi possível despachar o job: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (wait) {
      const finished = await waitForJob(job.id, 0);
      if (!finished) fail(`Job ${job.id} não terminou no tempo esperado`);
      const tail = readJobTail(finished!.logPath);
      console.log(`${finished!.status} (exit ${finished!.exitCode ?? "-"})`);
      if (tail.trim()) console.log(tail.trim());
      return result;
    }

    // Confirma que algum daemon assumiu o job antes de afirmar que está rodando.
    // Sem esta checagem o CLI diria "rodando em background" para um job que ninguém
    // pegou — a mesma mentira de superfície que já custou caro outras vezes.
    const started = await waitForJobStart(job.id, 2_000);
    const status = started?.status ?? job.status;
    const confirmed = status === "running" || isJobTerminal(status);

    result.status = status;

    if (asJson) {
      console.log(JSON.stringify({ ...result, confirmed }, null, 2));
      return result;
    }

    if (confirmed) {
      console.log(`Job ${job.id} rodando em background.`);
    } else {
      console.log(`Job ${job.id} despachado, mas nenhum daemon confirmou o início.`);
      console.log(`  confira com: ravi jobs show ${job.id}`);
    }
    console.log(`  log:  ${job.logPath}`);
    console.log(`  ver:  ravi jobs tail ${job.id}`);
    console.log(`  parar: ravi jobs kill ${job.id}`);
    if (job.sessionName) console.log(`  o desfecho volta para a sessão ${job.sessionName} quando terminar.`);
    return result;
  }

  @Command({ name: "list", description: "List jobs" })
  @CommandAccess({ kind: "read", resource: "jobs", action: "list", risk: "low" })
  @Returns(jobsListReturnSchema)
  list(
    @Option({ flags: "--session <name>", description: "Filter by session" }) sessionName?: string,
    @Option({ flags: "--all", description: "All sessions" }) all?: boolean,
    @Option({ flags: "--limit <n>", description: "Maximum jobs to return (default: 50)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of jobs to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const session = all ? null : resolveSessionName(sessionName);
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 50;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;
    const pageSize = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 50;
    const skip = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;

    const allJobs = dbListJobs({ sessionName: session, limit: 500 }).filter((job) => canUseJob(job, "read"));
    const items = allJobs.slice(skip, skip + pageSize);
    const payload = {
      total: allJobs.length,
      pagination: buildCliOffsetPagination({
        baseCommand: ["ravi", "jobs", "list"],
        limit: pageSize,
        offset: skip,
        returned: items.length,
        total: allJobs.length,
        options: [sessionName ? "--session" : null, sessionName ?? null, all ? "--all" : null],
      }),
      items: items.map(serializeJob),
    };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    if (items.length === 0) {
      console.log("Nenhum job.");
      return payload;
    }
    for (const job of items) {
      console.log(`${job.id}  ${job.status.padEnd(9)} ${job.command.slice(0, 70)}`);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one job" })
  @CommandAccess({ kind: "read", resource: "jobs", action: "show", risk: "low" })
  @Returns(jobsJobReturnSchema)
  show(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) _asJson?: boolean,
  ) {
    const job = getUsableJob(id, "read");
    if (!job) {
      fail(`Job não encontrado: ${id}`);
      return;
    }
    const payload = { job: serializeJob(job) };
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }

  @Command({ name: "tail", description: "Print the job log tail" })
  @CommandAccess({ kind: "read", resource: "jobs", action: "tail", risk: "low" })
  @Returns(jobsTailReturnSchema)
  tail(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "-n, --lines <n>", description: "How many characters to keep (default 4000)" }) lines?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = getUsableJob(id, "read");
    if (!job) {
      fail(`Job não encontrado: ${id}`);
      return;
    }
    const parsed = lines ? Number.parseInt(lines, 10) : 4_000;
    const chars = Number.isFinite(parsed) && parsed > 0 ? parsed : 4_000;
    const tail = readJobTail(job.logPath, chars);
    const payload = { id: job.id, status: job.status, logPath: job.logPath, tail };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    console.log(tail.trim() ? tail.trim() : "(sem saída ainda)");
    return payload;
  }

  @Command({ name: "wait", description: "Wait for a job to finish" })
  @CommandAccess({ kind: "read", resource: "jobs", action: "wait", risk: "low" })
  @Returns(jobsWaitReturnSchema)
  async wait(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "--timeout <ms>", description: "Give up after this many ms (default: no limit)" })
    timeoutMs?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsed = timeoutMs ? Number.parseInt(timeoutMs, 10) : 0;
    const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    if (!getUsableJob(id, "read")) {
      fail(`Job não encontrado: ${id}`);
      return;
    }
    const job = await waitForJob(id, timeout);
    if (!job) {
      fail(`Job ${id} não terminou no tempo esperado`);
      return;
    }
    const payload = {
      id: job.id,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      logPath: job.logPath,
    };
    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    console.log(`${job.status} (exit ${job.exitCode ?? "-"})`);
    return payload;
  }

  @Command({ name: "kill", description: "Stop a running job" })
  @CommandAccess({ kind: "mutate", resource: "jobs", action: "kill", risk: "medium" })
  @Returns(jobsKillReturnSchema)
  async kill(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = getUsableJob(id, "mutate");
    if (!job) {
      fail(`Job não encontrado: ${id}`);
      return;
    }
    if (isJobTerminal(job.status)) {
      const payload = { id, status: job.status, killed: false };
      if (asJson) console.log(JSON.stringify(payload, null, 2));
      else console.log(`Job ${id} já terminou (${job.status}).`);
      return payload;
    }
    // Quem mata é o dono do processo, não este processo.
    await nats.emit(JOB_KILL_TOPIC, { jobId: id });
    const payload = { id, status: job.status, killed: true };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`Pedido de kill enviado para ${id}.`);
    return payload;
  }

  /**
   * Contrato interno do wrapper de detach (`ravi-jobs-exec.sh`).
   *
   * O wrapper é quem rodou o comando e sabe o pid; o daemon não viu esse
   * processo nascer. Este comando existe para o handle que o agente recebe
   * apontar para uma linha que já existe — nunca para uma promessa.
   */
  @Command({
    name: "register",
    description: "Register a job that is already running (internal: detach wrapper)",
    helpAfter: `Chamado pelo wrapper de detach, não por pessoas.

  ravi jobs register --id job_abc --pid 4242 --log <path> --command "bun test" --session dev

Se o comando já terminou antes do registro, --exit fecha o job na mesma chamada:
a linha nasce terminal e nenhum desfecho é entregue (a saída já voltou no turno).`,
  })
  @CliOnly()
  @CommandAccess({ kind: "mutate", resource: "jobs", action: "register", risk: "low" })
  @Returns(jobsRegisterReturnSchema)
  register(
    @Option({ flags: "--id <id>", description: "Job id chosen by the wrapper" }) id?: string,
    @Option({ flags: "--pid <pid>", description: "PID of the process that owns the command" }) pid?: string,
    @Option({ flags: "--log <path>", description: "Log file the command writes to" }) logPath?: string,
    @Option({ flags: "--command <command>", description: "Original command line" }) command?: string,
    @Option({ flags: "--cwd <dir>", description: "Working directory" }) cwd?: string,
    @Option({ flags: "--session <name>", description: "Session to notify when the job finishes" })
    sessionName?: string,
    @Option({ flags: "--agent <id>", description: "Agent that owns the job" }) agentId?: string,
    @Option({ flags: "--exit <code>", description: "The command already finished with this exit code" })
    exitCode?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!id) fail("jobs register precisa de --id");
    if (!logPath) fail("jobs register precisa de --log");

    const parsedPid = pid ? Number.parseInt(pid, 10) : Number.NaN;
    const parsedExit = exitCode === undefined ? null : Number.parseInt(exitCode, 10);
    if (parsedExit !== null && !Number.isFinite(parsedExit)) fail(`--exit inválido: ${exitCode}`);

    const job = dbRegisterJob({
      id: id!,
      sessionName: resolveSessionName(sessionName),
      agentId: resolveAgentId(agentId),
      command: command ?? "",
      cwd: cwd ?? null,
      logPath: logPath!,
      pid: Number.isFinite(parsedPid) ? parsedPid : null,
      exit:
        parsedExit === null
          ? null
          : {
              status: jobStatusFromExitCode(parsedExit),
              exitCode: parsedExit,
              signal: signalFromExitCode(parsedExit),
            },
    });

    const payload = {
      id: job.id,
      status: job.status,
      pid: job.pid,
      logPath: job.logPath,
      origin: job.origin,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`${job.id}  ${job.status}  pid ${job.pid ?? "-"}`);
    return payload;
  }

  /**
   * Fecha um job de detach com o exit code real e avisa o daemon para entregar o
   * desfecho na sessão. Sem `--silent`, o runner manda o resultado para a sessão.
   */
  @Command({
    name: "finish",
    description: "Finish a detached job and deliver its outcome (internal: detach wrapper)",
    helpAfter: `Chamado pelo processo que rodou o comando, quando ele termina.

  ravi jobs finish --id job_abc
  ravi jobs finish --id job_abc --exit 0 --silent   # a saída já voltou no turno`,
  })
  @CliOnly()
  @CommandAccess({ kind: "mutate", resource: "jobs", action: "finish", risk: "low" })
  @Returns(jobsFinishReturnSchema)
  async finish(
    @Option({ flags: "--id <id>", description: "Job id" }) id?: string,
    @Option({ flags: "--exit <code>", description: "Exit code (default: read from the log state file)" })
    exitCode?: string,
    @Option({ flags: "--silent", description: "Do not deliver the outcome to the session" }) silent?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!id) fail("jobs finish precisa de --id");
    const job = dbGetJob(id!);
    // Terminou antes de a linha existir: nada a fechar e nada a entregar. O
    // wrapper trata esse caso lendo o estado por conta própria.
    if (!job) {
      const missing = { id: id!, status: "missing", exitCode: null, signal: null, notified: false };
      if (asJson) console.log(JSON.stringify(missing, null, 2));
      return missing;
    }

    if (!isJobTerminal(job.status)) {
      const parsedFromArg = exitCode === undefined ? null : Number.parseInt(exitCode, 10);
      const state = readJobExitState(job.logPath);
      const code = Number.isFinite(parsedFromArg as number) ? (parsedFromArg as number) : (state?.exitCode ?? null);
      if (code === null) fail(`Job ${job.id} não tem exit code: passe --exit ou verifique ${job.logPath}.exit`);
      dbFinishJob(job.id, {
        status: jobStatusFromExitCode(code as number),
        exitCode: code as number,
        signal: signalFromExitCode(code as number),
      });
    }

    const finished = dbGetJob(job.id) ?? job;
    let notified = false;
    if (!silent && !finished.notifiedAt && isJobTerminal(finished.status)) {
      try {
        await nats.emit(JOB_FINISHED_TOPIC, { jobId: finished.id });
        notified = true;
      } catch {
        // Sem daemon escutando, o reconcile entrega depois. Não é falha do job.
        notified = false;
      }
    }

    const payload = {
      id: finished.id,
      status: finished.status,
      exitCode: finished.exitCode,
      signal: finished.signal,
      notified,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`${finished.id}  ${finished.status}  exit ${finished.exitCode ?? "-"}`);
    return payload;
  }
}

/**
 * Espera curta e limitada por uma transição de estado. Serve para o CLI dizer a
 * verdade sobre o que foi confirmado, sem transformar `jobs run` numa chamada lenta.
 */
async function waitForJobStart(id: string, timeoutMs: number): Promise<JobRecord | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = dbGetJob(id);
    if (!job) return null;
    if (job.status !== "pending") return job;
    if (Date.now() >= deadline) return job;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function waitForJob(id: string, timeoutMs: number): Promise<JobRecord | null> {
  const started = Date.now();
  for (;;) {
    const job = dbGetJob(id);
    if (!job) return null;
    if (isJobTerminal(job.status)) return job;
    if (timeoutMs > 0 && Date.now() - started > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

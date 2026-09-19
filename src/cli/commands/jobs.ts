import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { z } from "zod";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import { nats } from "../../nats.js";
import { getRaviStateDir } from "../../utils/paths.js";
import { getContext } from "../context.js";
import {
  dbCreateJob,
  dbGetJob,
  dbListJobs,
  isJobTerminal,
  JOB_KILL_TOPIC,
  JOB_START_TOPIC,
  readJobTail,
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

const jobsListReturnSchema = z.object({
  total: z.number(),
  pagination: z.record(z.string(), z.unknown()).optional(),
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
    const jobId = `job_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const job = dbCreateJob({
      id: jobId,
      sessionName: resolveSessionName(sessionName),
      agentId: resolveAgentId(agentId),
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

    const allJobs = dbListJobs({ sessionName: session, limit: 500 });
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
    const job = dbGetJob(id);
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
  tail(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "-n, --lines <n>", description: "How many characters to keep (default 4000)" }) lines?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetJob(id);
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
  async wait(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "--timeout <ms>", description: "Give up after this many ms (default: no limit)" })
    timeoutMs?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsed = timeoutMs ? Number.parseInt(timeoutMs, 10) : 0;
    const timeout = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
  async kill(
    @Arg("id", { description: "Job id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const job = dbGetJob(id);
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

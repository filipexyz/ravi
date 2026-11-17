/**
 * CLI falsa para os testes do wrapper de detach.
 *
 * O wrapper chama `${RAVI_JOBS_CLI} jobs register|finish ...`. Nos testes,
 * `RAVI_JOBS_CLI` aponta para este arquivo rodando com bun: mesma escrita no
 * banco (store real), sem pagar o boot do CLI inteiro (~5s medidos na máquina
 * de produção), que transformaria um teste de 2s em um teste de 15s.
 *
 * Nada aqui é usado em produção.
 */

import { appendFileSync } from "node:fs";
import { jobStatusFromExitCode, readJobExitState, signalFromExitCode } from "../detach.js";
import { dbFinishJob, dbGetJob, dbRegisterJob } from "../store.js";

const argv = process.argv.slice(2);
const command = argv[0];
const subcommand = argv[1];
const flags = parseFlags(argv.slice(2));

function parseFlags(args: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      parsed[name] = next;
      index++;
    } else {
      parsed[name] = true;
    }
  }
  return parsed;
}

function record(): void {
  const logPath = process.env.RAVI_TEST_FAKE_CLI_LOG;
  if (!logPath) return;
  appendFileSync(logPath, `${argv.join(" ")}\n`);
}

if (command !== "jobs" || !subcommand) {
  process.stderr.write("fake-cli: use `jobs register|finish`\n");
  process.exit(2);
}

record();

if (process.env.RAVI_TEST_FAKE_CLI_REGISTER_FAILS === "1" && subcommand === "register") {
  process.stderr.write("fake-cli: register refused on purpose\n");
  process.exit(3);
}

if (subcommand === "register") {
  const id = String(flags.id ?? "");
  const exitCode = flags.exit === undefined ? null : Number.parseInt(String(flags.exit), 10);
  const pid = flags.pid === undefined ? null : Number.parseInt(String(flags.pid), 10);
  const job = dbRegisterJob({
    id,
    sessionName: typeof flags.session === "string" ? flags.session : null,
    agentId: typeof flags.agent === "string" ? flags.agent : null,
    command: typeof flags.command === "string" ? flags.command : "",
    cwd: typeof flags.cwd === "string" ? flags.cwd : null,
    logPath: String(flags.log ?? ""),
    pid: pid !== null && Number.isFinite(pid) ? pid : null,
    exit:
      exitCode !== null && Number.isFinite(exitCode)
        ? {
            status: jobStatusFromExitCode(exitCode),
            exitCode,
            signal: signalFromExitCode(exitCode),
          }
        : null,
  });
  process.stdout.write(`${JSON.stringify({ id: job.id, status: job.status })}\n`);
  process.exit(0);
}

if (subcommand === "finish") {
  const id = String(flags.id ?? "");
  const job = dbGetJob(id);
  if (!job) process.exit(0);
  const fromArg = flags.exit === undefined ? null : Number.parseInt(String(flags.exit), 10);
  const state = readJobExitState(job.logPath);
  const exitCode = Number.isFinite(fromArg as number) ? (fromArg as number) : (state?.exitCode ?? null);
  if (exitCode === null) process.exit(4);
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "killed") {
    dbFinishJob(job.id, {
      status: jobStatusFromExitCode(exitCode),
      exitCode,
      signal: signalFromExitCode(exitCode),
    });
  }
  process.stdout.write(`${JSON.stringify({ id: job.id, exitCode })}\n`);
  process.exit(0);
}

process.stderr.write(`fake-cli: subcomando desconhecido ${subcommand}\n`);
process.exit(2);

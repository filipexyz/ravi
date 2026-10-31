import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../router/router-db.js";
import { dbGetJob, dbListJobs } from "./store.js";
import { JobsRunner } from "./runner.js";
import { ensureDetachScript, resetDetachScriptCache } from "./detach-script.js";
import type { JobRecord } from "./types.js";

/**
 * Teste do wrapper de verdade: shell, timer, setsid, registro e desfecho.
 *
 * O CLI falso (`__test__/fake-jobs-cli.ts`) escreve no DB real do store, mas sem
 * pagar os ~5s de boot do CLI inteiro. O que se testa aqui é o mecanismo, não o
 * parser de flags do CLI (coberto em `jobs.test.ts`).
 */

const FAKE_CLI = join(import.meta.dir, "__test__", "fake-jobs-cli.ts");
const SESSION = `test-detach-${process.pid}-${Date.now()}`;
const cleanupIds: string[] = [];
const cleanupDirs: string[] = [];
const tempStateDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempStateDirs.push(dir);
  return dir;
}

function scriptPathFor(detachAfterMs: number): string {
  return ensureDetachScript({
    env: { ...process.env, RAVI_STATE_DIR: tempDir("ravi-detach-script-") },
    detachAfterMs,
  });
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runWrapper(
  scriptPath: string,
  command: string,
  options: { detachAfterMs?: number; env?: Record<string, string> } = {},
): RunResult {
  const started = Date.now();
  const result = spawnSync(scriptPath, ["--session", SESSION, "--", command], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      RAVI_JOBS_CLI: `bun ${FAKE_CLI}`,
      RAVI_JOBS_DETACH_AFTER_MS: String(options.detachAfterMs ?? 25_000),
      ...options.env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - started,
  };
}

function jobsForSession(): JobRecord[] {
  return dbListJobs({ sessionName: SESSION, limit: 50 });
}

async function waitForJob(id: string, predicate: (job: JobRecord) => boolean, timeoutMs = 10_000): Promise<JobRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = dbGetJob(id);
    if (job && predicate(job)) return job;
    if (Date.now() > deadline)
      throw new Error(`job ${id} did not reach the expected state; last=${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

afterEach(() => {
  const db = getDb();
  for (const id of cleanupIds.splice(0)) db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  for (const job of jobsForSession()) db.prepare("DELETE FROM jobs WHERE id = ?").run(job.id);
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of tempStateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetDetachScriptCache();
});

function trackJob(job: JobRecord): JobRecord {
  cleanupIds.push(job.id);
  cleanupDirs.push(join(job.logPath, ".."));
  return job;
}

/** O handle é o token `job_…` da primeira linha do retorno do wrapper. */
function detachedJobId(stdout: string): string | undefined {
  const firstLine = stdout.split("\n", 1)[0] ?? "";
  return firstLine.split(" ").find((token) => token.startsWith("job_"));
}

describe("detach wrapper: fast path", () => {
  it("is indistinguishable from running the command directly", () => {
    const scriptPath = scriptPathFor(25_000);
    const result = runWrapper(scriptPath, "printf hi");

    expect(result.stdout).toBe("hi");
    expect(result.status).toBe(0);
    expect(result.durationMs).toBeLessThan(5_000);
    // Nada foi registrado: o diretório de execução é descartável.
    expect(jobsForSession()).toEqual([]);
  });

  it("keeps the output and the exit code", () => {
    const scriptPath = scriptPathFor(25_000);
    const result = runWrapper(scriptPath, "printf out; printf err >&2; exit 7");

    // O log do job é um stream só; stderr sai junto do stdout, como no resultado
    // combinado da tool. O que não pode mudar é o conteúdo e o exit code.
    expect(result.stdout).toBe("outerr");
    expect(result.status).toBe(7);
    expect(jobsForSession()).toEqual([]);
  });

  it("honours the kill switch by running the command without the wrapper", () => {
    const scriptPath = scriptPathFor(0);
    const result = runWrapper(scriptPath, "printf direct", { env: { RAVI_JOBS_DETACH: "0" } });

    expect(result.stdout).toBe("direct");
    expect(result.status).toBe(0);
    expect(jobsForSession()).toEqual([]);
  });
});

describe("detach wrapper: detach path", () => {
  it("returns a handle while the command keeps running, then delivers the outcome", async () => {
    const scriptPath = scriptPathFor(400);
    const result = runWrapper(scriptPath, "sleep 1.2; printf done", { detachAfterMs: 400 });

    // O turno não espera o comando: o wrapper sai com um handle.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[detached] job ");
    expect(result.stdout).toContain("Você NÃO tem a saída dele neste retorno");
    expect(result.durationMs).toBeLessThan(3_000);

    const id = detachedJobId(result.stdout);
    expect(id).toBeTruthy();

    const registered = trackJob(await waitForJob(id!, (job) => job.status !== "pending"));
    expect(registered.origin).toBe("detach");
    expect(registered.sessionName).toBe(SESSION);
    expect(registered.command).toBe("sleep 1.2; printf done");
    expect(registered.pid).toBeGreaterThan(0);

    // O runner que sobrevive ao wrapper fecha o job com o exit code real.
    const finished = await waitForJob(id!, (job) => job.status === "succeeded" || job.status === "failed");
    expect(finished.status).toBe("succeeded");
    expect(finished.exitCode).toBe(0);
    expect(readFileSync(finished.logPath, "utf8")).toContain("done");

    // O desfecho chega na sessão uma vez, com tail.
    const deliveries: string[] = [];
    const runner = new JobsRunner({ notifySession: async (_job, summary) => void deliveries.push(summary) });
    await runner.handleJobFinished(id!);
    await runner.handleJobFinished(id!);

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(id!);
    expect(deliveries[0]).toContain("done");
    expect(dbGetJob(id!)?.notifiedAt).toBeGreaterThan(0);
  }, 20_000);

  it("reports a failed command as failed with its exit code", async () => {
    const scriptPath = scriptPathFor(300);
    const result = runWrapper(scriptPath, "sleep 0.8; printf boom; exit 9", { detachAfterMs: 300 });
    const id = detachedJobId(result.stdout);
    expect(id).toBeTruthy();

    const finished = trackJob(await waitForJob(id!, (job) => job.status === "failed" || job.status === "succeeded"));
    expect(finished.status).toBe("failed");
    expect(finished.exitCode).toBe(9);
  }, 20_000);

  it("is honest when the job was not registered", async () => {
    const scriptPath = scriptPathFor(300);
    const result = runWrapper(scriptPath, "sleep 0.6; printf done", {
      detachAfterMs: 300,
      env: { RAVI_TEST_FAKE_CLI_REGISTER_FAILS: "1" },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[detached-untracked]");
    expect(result.stdout).toContain("o job não foi registrado");
    // Não mentiu: não há linha de job para entregar um desfecho que não existe.
    expect(jobsForSession()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }, 20_000);
});

describe("detach kill path", () => {
  it("kills the process group and delivers a killed outcome", async () => {
    const scriptPath = scriptPathFor(300);
    const result = runWrapper(scriptPath, "sleep 30", { detachAfterMs: 300 });
    const id = detachedJobId(result.stdout);
    expect(id).toBeTruthy();

    const registered = trackJob(await waitForJob(id!, (job) => job.pid !== null));
    expect(registered.status).toBe("running");

    const deliveries: Array<{ job: JobRecord; summary: string }> = [];
    const runner = new JobsRunner({
      notifySession: async (job, summary) => void deliveries.push({ job, summary }),
    });

    expect(await runner.killJob(id!)).toBe(true);

    const killed = await waitForJob(id!, (job) => job.status === "killed" || job.status === "failed", 12_000);
    expect(killed.status).toBe("killed");
    expect(killed.signal).toBe("SIGTERM");
    expect(killed.exitCode).toBe(143);

    const deadline = Date.now() + 5_000;
    while (deliveries.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.summary).toContain("killed");
    expect(existsSync(killed.logPath)).toBe(true);
  }, 25_000);
});

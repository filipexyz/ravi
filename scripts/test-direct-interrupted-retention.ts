/** Runs only the retained direct-interruption integration suite; never removes evidence. */
import { spawn } from "bun";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureRetainedProtectedRoots, retainedMacProfile } from "../src/test/retained-preload-policy.js";

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const defaultTest = "src/runtime/direct-interrupted-retention.test.ts";
const preload = join(repo, "src/test/retained-memory-preload.ts");
const scenarios = new Set([
  "bot-replay", "human-replay", "normal-final", "event-fence-no-replay", "tool-fence-no-replay",
  "explicit-abort", "owner-replaced",
]);

/** Parses only fixture selection needed for an unchanged oracle or a focused regression run. */
function options(argv: string[]): { testFile: string; pattern?: string; scenario?: string } {
  let testFile = defaultTest;
  let pattern: string | undefined;
  let scenario: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${option}`);
    if (option === "--test-file") testFile = value;
    else if (option === "--test-name-pattern") pattern = value;
    else if (option === "--scenario" && scenarios.has(value)) scenario = value;
    else throw new Error(`Unsupported argument: ${option}`);
  }
  const path = realpathSync(resolve(repo, testFile));
  const withinRuntime = relative(join(repo, "src/runtime"), path);
  if (
    !withinRuntime || withinRuntime === ".." || withinRuntime.startsWith(`..${sep}`) ||
    isAbsolute(withinRuntime) || !path.endsWith(".test.ts")
  ) {
    throw new Error("Fixture must be an existing .test.ts under this checkout's src/runtime");
  }
  return { testFile: path, pattern, scenario };
}

/** Hashes bytes recorded for this invocation, including uncommitted source changes. */
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Requires actual executed test evidence; skips, todo and zero selected tests are not validation. */
function testCounts(output: string): { pass: number; fail: number; skip: number; todo: number; ran: number } {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const count = (label: string) => {
    const matches = [...clean.matchAll(new RegExp(`^\\s*(\\d+) ${label}\\s*$`, "gm"))];
    return Number(matches.at(-1)?.[1] ?? 0);
  };
  const runs = [...clean.matchAll(/Ran (\d+) tests? across /g)];
  return {
    pass: count("pass"), fail: count("fail"), skip: count("skip"), todo: count("todo"),
    ran: Number(runs.at(-1)?.[1] ?? 0),
  };
}

/** Allocates evidence first, then launches a credential-free test child with platform-specific guards. */
async function main(): Promise<number> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Retained runner has no declared isolation path for ${process.platform}`);
  }
  const selected = options(process.argv.slice(2));
  const protectedRoots = captureRetainedProtectedRoots(homedir());
  const space = statfsSync(repo);
  const freeBytes = Number(space.bavail) * Number(space.bsize);
  if (freeBytes < 512 * 1024 * 1024) throw new Error("Retained runner stopped: less than 512 MiB free");
  const run = join(
    repo, ".ravi-test-artifacts/direct-interrupted",
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`,
  );
  const state = join(run, "state");
  const tmp = join(run, "tmp");
  mkdirSync(join(state, "home"), { recursive: true });
  mkdirSync(tmp);
  const sourcePaths = [
    selected.testFile, preload, fileURLToPath(import.meta.url),
    join(repo, "src/test/retained-preload-policy.ts"),
    join(repo, "src/test/retained-preload-sqlite.ts"),
    join(repo, "src/runtime/host-event-loop.ts"),
    join(repo, "src/runtime/delivery-queue.ts"),
    join(repo, "src/runtime/host-session.ts"),
    join(repo, "src/runtime/direct-interrupted-retention.ts"),
  ];
  const sources = sourcePaths.filter(existsSync).map((path, index) => {
    const bytes = readFileSync(path);
    const saved = `source-${index}-${path.split(sep).at(-1)}`;
    writeFileSync(join(run, saved), bytes);
    return { path: relative(repo, path), sha256: sha256(bytes), retainedCopy: saved };
  });
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM"]) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  Object.assign(childEnv, {
    TMPDIR: tmp,
    PR795_RETAINED_STATE: state,
    PR795_RUN_EVIDENCE: run,
    PR795_PROTECTED_ROOTS: JSON.stringify(protectedRoots),
    RAVI_STATE_DIR: state,
    RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    NATS_URL: "nats://127.0.0.1:1",
    NO_COLOR: "1",
    ...(selected.scenario ? { PR795_SCENARIO: selected.scenario } : {}),
  });
  const testArgs = [
    process.execPath, "test", "--no-env-file", "--timeout", "20000", "--preload", preload,
    ...(selected.pattern ? ["--test-name-pattern", selected.pattern] : []),
    selected.testFile,
  ];
  let argv = testArgs;
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/sandbox-exec")) throw new Error("macOS sandbox-exec is required for this runner");
    const profile = join(run, "no-removal.sb");
    writeFileSync(profile, retainedMacProfile(protectedRoots));
    argv = ["/usr/bin/sandbox-exec", "-f", profile, ...testArgs];
  }
  const metadata: Record<string, unknown> = {
    schema: "ravi.direct-interrupted.retained-run/v1",
    startedAt: new Date().toISOString(),
    cwd: repo,
    argv,
    sources,
    scenario: selected.scenario ?? null,
    testNamePattern: selected.pattern ?? null,
    retainedRunDirectory: run,
    preflightFreeBytes: freeBytes,
    processTimeoutMs: 45_000,
    isolation: process.platform === "darwin" ? "macos-os-profile-and-preload" : "linux-preload-api-guards",
    linuxOsSandboxClaimed: false,
    cleanup: false,
    diskPersistenceTested: false,
    credentialsInherited: false,
    HOMEorCODEX_HOMEAssigned: false,
  };
  writeFileSync(join(run, "run.json"), JSON.stringify(metadata, null, 2));
  console.log(`Retained direct-interruption evidence: ${run}`);
  try {
    const child = spawn(argv, {
      cwd: repo,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 45_000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    writeFileSync(join(run, "stdout.log"), stdout);
    writeFileSync(join(run, "stderr.log"), stderr);
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    const counts = testCounts(`${stdout}\n${stderr}`);
    const snapshotPresent = existsSync(join(run, "memory-sql-snapshot.json"));
    const valid = exitCode === 0 && counts.pass > 0 && counts.ran === counts.pass &&
      counts.fail === 0 && counts.skip === 0 && counts.todo === 0 && snapshotPresent;
    Object.assign(metadata, { exitCode, signalCode: child.signalCode, counts, snapshotPresent, validationPassed: valid });
    writeFileSync(join(run, "run.json"), JSON.stringify({ ...metadata, completedAt: new Date().toISOString() }, null, 2));
    if (!valid) console.error("Retained validation failed: nonzero exit, missing evidence, zero tests, or skipped tests");
    return valid ? 0 : 1;
  } catch (error) {
    writeFileSync(join(run, "run.json"), JSON.stringify({
      ...metadata, completedAt: new Date().toISOString(), validationPassed: false, error: String(error),
    }, null, 2));
    throw error;
  }
}

process.exitCode = await main();

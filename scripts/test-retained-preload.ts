/** Runs guard counterexamples behind an independent OS boundary, retaining every child outcome. */
import { spawn, spawnSync } from "bun";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureRetainedProtectedRoots, retainedMacProfile } from "../src/test/retained-preload-policy.js";

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const scenarios = [
  "root-alias", "root-lexical", "link-sync", "link-callback", "link-promises", "link-inside",
  "dns-nested", "dns-default", "dns-bare", "dns-standalone", "dns-bare-standalone", "dns-top",
  "closed-memory", "live-latest", "same-request-distinct", "close-false", "close-true-idle", "double-close",
  "dispose", "dispose-decorated-close", "close-true-busy", "snapshot-query-error-caught", "policy-contract", "failed-close-live", "snapshot-error-then-live",
];
const sources = [
  "src/test/retained-memory-preload.ts", "src/test/retained-preload-policy.ts", "src/test/retained-preload-sqlite.ts",
  "src/test/retained-preload-contract.bootstrap.ts", "src/test/retained-preload-contract.fixture.test.ts",
  "src/test/retained-preload-dns-sentinels.ts", "src/test/retained-preload-sqlite-cases.ts",
  "src/test/retained-preload-policy-cases.ts", "scripts/test-retained-preload.ts",
];

/** Reads exact Git objects for provenance; source hashes independently include uncommitted changes. */
function gitObject(name: string): string {
  const child = spawnSync(["git", "rev-parse", name], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error("Cannot record retained source Git provenance");
  return child.stdout.toString().trim();
}

/** Parses the one child's Bun summary; an expected fatal refusal is classified separately from success. */
function counts(stderr: string) {
  const count = (name: string) => Number([...stderr.matchAll(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, "gm"))].at(-1)?.[1] ?? 0);
  return { pass: count("pass"), fail: count("fail"), skip: count("skip"), todo: count("todo") };
}

/** Requires the same body assertions plus complete retained evidence, including intentional fatal controls. */
function verify(scenario: string, stdout: string, stderr: string, exit: number, snapshot: any): void {
  const markers = stdout.split("\n").filter((line) => line.startsWith("RETAINED_GUARD_CASE_OK "));
  assert.equal(markers.length, 1, "The fixture body must complete exactly once");
  const body = JSON.parse(markers[0].slice("RETAINED_GUARD_CASE_OK ".length));
  assert.equal(body.scenario, scenario);
  assert.deepEqual(body.dnsCalls, [], "No original DNS sentinel may be reached by the fixed guard");
  const filesystemRefusal = ["root-alias", "root-lexical", "link-sync", "link-callback", "link-promises"].includes(scenario);
  const captureRefusal = ["snapshot-query-error-caught", "snapshot-error-then-live"].includes(scenario);
  const fatal = filesystemRefusal || captureRefusal;
  assert.deepEqual(counts(stderr), { pass: 1, fail: fatal ? 1 : 0, skip: 0, todo: 0 });
  assert.equal(exit, fatal ? 1 : 0, "Expected fatal controls must still make the real preload reject validation");
  assert.equal(snapshot.diskPersistenceTested, false);
  assert.deepEqual(snapshot.blocked, []);
  assert.equal(snapshot.fileDenials.length, filesystemRefusal ? 1 : 0);
  assert.equal(snapshot.networkDenied.length, scenario.startsWith("dns-") ? 1 : 0);
  assert.equal(snapshot.snapshots.filter((item: any) => "error" in item).length, captureRefusal ? 1 : 0);
  assert.deepEqual(snapshot.snapshots[0].tables.probe_control, [{ value: "present" }]);
  if (scenario === "link-inside") assert.equal(body.calls.length, 1);
  else assert.deepEqual(body.calls, []);
  const expected = body.observation?.expectedSnapshots;
  assert.equal(snapshot.snapshots.length, 1 + (expected?.length ?? 0));
  if (expected) {
    for (const [index, item] of expected.entries()) {
      const actual = snapshot.snapshots[index + 1];
      assert.equal(actual.requested, item.requested);
      if (item.errorIncludes) assert.ok(actual.error?.includes(item.errorIncludes), "Capture failure must remain explicit");
      else {
        assert.equal(actual.error, undefined);
      }
      if (item.tables) assert.deepEqual(actual.tables, item.tables);
    }
  }
}

/** Runs only on the platform where this runner can independently deny egress and physical deletion. */
async function main(): Promise<number> {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    throw new Error("Retained guard probes require macOS sandbox-exec; CI runs this command in its dedicated macOS job");
  }
  const space = statfsSync(repo);
  const freeBytes = Number(space.bavail) * Number(space.bsize);
  const estimatedBytes = 20 * 1024 * 1024;
  if (freeBytes - estimatedBytes < 512 * 1024 * 1024) throw new Error("Insufficient projected space for retained probes");
  const run = join(repo, ".ravi-test-artifacts/retained-preload", `${Date.now()}-${randomUUID()}`);
  mkdirSync(run, { recursive: true });
  // No metadata lookup of the real private roots in probes. All exercised root
  // resolution is injected/synthetic; these lexical roots add outer protection.
  const outerRoots = captureRetainedProtectedRoots(homedir(), (path) => path);
  const profile = join(run, "independent.sb");
  writeFileSync(profile, retainedMacProfile(outerRoots));
  const provenance = sources.map((path) => {
    const bytes = readFileSync(join(repo, path));
    return {
      path, sha256: createHash("sha256").update(bytes).digest("hex"),
      blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
    };
  });
  const metadata = {
    head: gitObject("HEAD"), tree: gitObject("HEAD^{tree}"), provenance, freeBytes, estimatedBytes,
    isolation: "macos-deny-network-and-unlink-plus-inert-original-sentinels",
    privateMetadataProbed: false, realDnsInvoked: false, realHardLinksCreated: false,
    cleanup: false, HOMEorCODEX_HOMEAssigned: false,
  };
  writeFileSync(join(run, "provenance.json"), JSON.stringify(metadata, null, 2));
  const results = [];
  for (const scenario of scenarios) {
    const childRoot = join(run, scenario);
    const state = join(childRoot, "state");
    mkdirSync(join(state, "home"), { recursive: true });
    mkdirSync(join(childRoot, "tmp"));
    const env: Record<string, string> = {};
    for (const key of ["PATH", "LANG", "LC_ALL", "TERM"]) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, {
      PR795_RETAINED_STATE: state, PR795_RUN_EVIDENCE: childRoot, RAVI_STATE_DIR: state,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1", RETAINED_GUARD_SCENARIO: scenario, NO_COLOR: "1", TMPDIR: join(childRoot, "tmp"),
    });
    const argv = ["/usr/bin/sandbox-exec", "-f", profile, process.execPath, "test", "--no-env-file", "--timeout", "20000",
      "--preload", "./src/test/retained-preload-contract.bootstrap.ts", "./src/test/retained-preload-contract.fixture.test.ts"];
    const child = spawn(argv, { cwd: repo, env, stdout: "pipe", stderr: "pipe", timeout: 45_000, killSignal: "SIGKILL" });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    writeFileSync(join(childRoot, "stdout.log"), stdout);
    writeFileSync(join(childRoot, "stderr.log"), stderr);
    let error: string | undefined;
    try {
      assert.equal(child.signalCode, null);
      const snapshot = JSON.parse(readFileSync(join(childRoot, "memory-sql-snapshot.json"), "utf8"));
      verify(scenario, stdout, stderr, exit, snapshot);
    } catch (cause) { error = String(cause); }
    const result = { scenario, argv, exit, counts: counts(stderr), contractPassed: !error, error };
    writeFileSync(join(childRoot, "result.json"), JSON.stringify(result, null, 2));
    results.push(result);
    console.log(`${error ? "FAIL" : "PASS"} ${scenario}${error ? `: ${error}` : ""}`);
  }
  writeFileSync(join(run, "summary.json"), JSON.stringify({ ...metadata, results }, null, 2));
  console.log(`Retained guard evidence: ${relative(repo, run)}`);
  return results.every((result) => result.contractPassed) ? 0 : 1;
}

process.exitCode = await main();

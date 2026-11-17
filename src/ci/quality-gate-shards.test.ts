import { expect, it } from "bun:test";
import { YAML } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type WorkflowJob = {
  name?: string;
  if?: string;
  needs?: string | string[];
  strategy?: { matrix?: { shard?: number[] } };
  steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
};

const root = resolve(import.meta.dir, "../..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const workflow = YAML.parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, WorkflowJob>;
};

// Jobs that run in CI but are deliberately not part of the required gate
// (they need macOS runners or a Node container, and were never required).
// Naming them here makes a new or renamed job fail this test until someone
// decides whether it gates.
const NOT_GATED = ["managed-runtime-launcher", "retained-preload", "sdk-node18-platform"];

const shardScripts = Object.keys(pkg.scripts)
  .filter((name) => /^test:shard-\d+$/.test(name))
  .sort((a, b) => Number(a.split("-").pop()) - Number(b.split("-").pop()));

it("`bun run test` is exactly the union of the CI shards", () => {
  expect(shardScripts.length).toBeGreaterThan(1);
  expect(shardScripts).toEqual(shardScripts.map((_, i) => `test:shard-${i + 1}`));
  // A shard script that `test` does not run (or runs twice) is a test left out
  // of, or duplicated across, the local and CI runs.
  expect(pkg.scripts.test!.split(" && ")).toEqual(shardScripts.map((name) => `bun run ${name}`));
  const segments = shardScripts.flatMap((name) => pkg.scripts[name]!.split(" && "));
  for (const name of shardScripts) expect(pkg.scripts[name]!.trim()).not.toBe("");
  expect(new Set(segments).size).toBe(segments.length);
});

it("CI runs every shard exactly once", () => {
  const tests = workflow.jobs.tests!;
  expect(tests.strategy?.matrix?.shard).toEqual(shardScripts.map((_, i) => i + 1));
  const runs = tests.steps!.filter((step) => step.run?.includes("bun run test:shard"));
  expect(runs.map((step) => step.run!.trim())).toEqual(["bun run test:shard-${{ matrix.shard }}"]);
  // The sharded job must not also run the unsharded chain.
  for (const [id, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      expect(/\bbun run test(\s|$)/.test(step.run ?? ""), `${id}: ${step.name}`).toBe(false);
    }
  }
});

it("Quality Gate fails unless every gated job succeeded", () => {
  const gate = workflow.jobs["quality-gate"]!;
  // Required status checks match the job's display name.
  expect(gate.name).toBe("Quality Gate");
  // A skipped gate counts as passing for a required check.
  expect(gate.if).toBe("always()");

  for (const id of NOT_GATED) expect(workflow.jobs[id], id).toBeDefined();
  const gated = Object.keys(workflow.jobs)
    .filter((id) => id !== "quality-gate" && !NOT_GATED.includes(id))
    .sort();
  expect([...(gate.needs as string[])].sort()).toEqual(gated);
  expect(gated).toContain("tests");

  const verdict = gate.steps!.find((step) => step.env?.NEEDS === "${{ toJSON(needs) }}");
  expect(verdict).toBeDefined();
  // Fails on failure, cancelled and skipped alike: only "success" passes, and
  // the count is pinned so a dropped dependency cannot pass silently.
  expect(verdict!.run).toContain(`length == ${gated.length} and all(.[]; .result == "success")`);
  expect(verdict!.run).toContain("jq -e");
});

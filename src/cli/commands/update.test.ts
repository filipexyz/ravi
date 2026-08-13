import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManagedRuntimeTargetFromPackageRoot } from "../../managed-runtime.js";
import {
  buildManagedRuntimeRebindPlan,
  buildManagedRuntimeRebindSupervisorInvocation,
  decodeManagedRuntimeRebindRequest,
  rebindManagedRuntimeProcesses,
} from "../../managed-runtime-rebind.js";
import type { Pm2Process } from "../../pm2.js";
import {
  detectFromBinaryPath,
  findPackageRoot,
  packageTagForChannel,
  packageTagForVersion,
  resolveUpdatedManagedRuntimeTarget,
  resolveUpdateChannel,
  validateExpectedIntegrity,
} from "./update.js";

const MANAGED_RUNTIME_REBIND_ENV = "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND";

function createRuntimePackage(version = "3.260812.2") {
  const root = mkdtempSync(join(tmpdir(), "ravi-update-runtime-"));
  const bundlePath = join(root, "dist", "bundle", "index.js");
  mkdirSync(join(bundlePath, ".."), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ravi.bot", version }), "utf8");
  writeFileSync(bundlePath, "", "utf8");
  return {
    root: realpathSync(root),
    bundlePath: realpathSync(bundlePath),
    target: resolveManagedRuntimeTargetFromPackageRoot(root)!,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function pm2Process(
  name: "ravi" | "ravi-channels",
  bundlePath: string,
  cwd: string,
  overrides: Partial<Pm2Process> = {},
): Pm2Process {
  return {
    name,
    pm_id: name === "ravi" ? 1 : 2,
    pid: name === "ravi" ? 101 : 202,
    status: "online",
    cpu: 0,
    memory: 0,
    execPath: name === "ravi" ? bundlePath : "/usr/local/bin/bun",
    cwd,
    args: name === "ravi" ? ["daemon", "run"] : [bundlePath, "channels", "run"],
    createdAt: 2,
    ...overrides,
  };
}

describe("update command helpers", () => {
  it("resolves explicit channel flags before persisted config", () => {
    expect(resolveUpdateChannel({ next: true }, { updateChannel: "latest" })).toBe("next");
    expect(resolveUpdateChannel({ stable: true }, { updateChannel: "next" })).toBe("latest");
  });

  it("uses persisted channel and falls back to latest", () => {
    expect(resolveUpdateChannel({}, { updateChannel: "next" })).toBe("next");
    expect(resolveUpdateChannel({}, {})).toBe("latest");
  });

  it("formats package tags for npm channels", () => {
    expect(packageTagForChannel("next")).toBe("ravi.bot@next");
    expect(packageTagForChannel("latest")).toBe("ravi.bot@latest");
  });

  it("normalizes and pins exact package versions", () => {
    expect(packageTagForVersion("v3.260811.2")).toBe("ravi.bot@3.260811.2");
    expect(() => packageTagForVersion("next")).toThrow("exact version");
    expect(() => packageTagForVersion("3.260811.2 || latest")).toThrow("exact version");
  });

  it("accepts only sha512 SRI values for release verification", () => {
    const integrity = `sha512-${"A".repeat(86)}==`;
    expect(validateExpectedIntegrity(integrity)).toBe(integrity);
    expect(() => validateExpectedIntegrity("sha256-not-enough")).toThrow("sha512");
    expect(() => validateExpectedIntegrity("sha512-A")).toThrow("sha512");
  });

  it("returns one machine-readable usage error for an invalid exact version", () => {
    const stateDir = join(tmpdir(), `ravi-update-contract-${process.pid}`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      RAVI_STATE_DIR: stateDir,
      RAVI_SUPPRESS_AUDIT_EVENTS: "1",
    };
    delete env.RAVI_CONTEXT_KEY;
    delete env.RAVI_SESSION_KEY;
    const result = spawnSync("bun", ["src/cli/index.ts", "update", "--version", "latest", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
    rmSync(stateDir, { recursive: true, force: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false,
      op: "ravi update",
      error: { code: "USAGE_ERROR", retryable: false },
    });
  });

  it("detects common global install paths", () => {
    expect(detectFromBinaryPath("/home/tester/.bun/bin/ravi")).toBe("bun");
    expect(detectFromBinaryPath("/opt/node/lib/node_modules/ravi.bot/bin/ravi")).toBe("npm");
  });

  it("finds the package root from this test file", () => {
    const root = findPackageRoot(import.meta.path);
    expect(root).toBeTruthy();
    const pkg = JSON.parse(readFileSync(join(root!, "package.json"), "utf8")) as { name?: string };
    expect(pkg.name).toBe("ravi.bot");
  });

  it("resolves the explicitly updated package before the currently executing bundle", () => {
    const runtime = createRuntimePackage();
    try {
      expect(resolveUpdatedManagedRuntimeTarget(runtime.root)).toEqual(runtime.target);
    } finally {
      runtime.cleanup();
    }
  });

  it("recreates managed processes from the updated bundle and saves PM2", () => {
    const target = { bundlePath: "/new/dist/bundle/index.js", cwd: "/new", version: "3.2.0" };
    const plan = buildManagedRuntimeRebindPlan(
      [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "online", pid: 20, createdAt: 1 },
      ],
      target,
      "/usr/bin/bun",
    );

    expect(
      plan.map(({ action, ...step }) => ({
        action,
        ...("processName" in step ? { processName: step.processName } : {}),
      })),
    ).toEqual([
      { action: "delete", processName: "ravi-channels" },
      { action: "delete", processName: "ravi" },
      { action: "start", processName: "ravi" },
      { action: "start", processName: "ravi-channels" },
      { action: "save" },
    ]);
    expect(plan[2]).toMatchObject({ cwd: target.cwd });
    expect(plan[2]?.args.slice(0, 2)).toEqual(["start", target.bundlePath]);
    expect(plan[3]).toMatchObject({ cwd: target.cwd });
    expect(plan[3]?.args.slice(0, 2)).toEqual(["start", "/usr/bin/bun"]);
  });

  it("removes stopped stale entries without starting them", () => {
    const plan = buildManagedRuntimeRebindPlan(
      [
        { name: "ravi", status: "online", pid: 10, createdAt: 1 },
        { name: "ravi-channels", status: "stopped", pid: 0, createdAt: 1 },
      ],
      { bundlePath: "/new/dist/bundle/index.js", cwd: "/new", version: "3.2.0" },
      "/usr/bin/bun",
    );
    expect(plan.filter((step) => step.action === "start").map((step) => step.processName)).toEqual(["ravi"]);
    expect(plan.map((step) => step.action)).toEqual(["delete", "delete", "start", "save"]);
    expect(buildManagedRuntimeRebindPlan([], { bundlePath: "/new", cwd: "/new", version: "3.2.0" })).toEqual([]);
  });

  it("launches the supervisor from the updated bundle with a sanitized request", () => {
    const runtime = createRuntimePackage();
    try {
      const invocation = buildManagedRuntimeRebindSupervisorInvocation(
        runtime.target,
        [pm2Process("ravi", "/old/index.js", "/old", { pid: 10, createdAt: 1 })],
        { ...process.env, RAVI_CONTEXT_KEY: "secret", RAVI_REPO: "/old" },
      );
      expect(invocation).toMatchObject({
        command: process.execPath,
        args: [runtime.bundlePath],
        cwd: runtime.root,
      });
      expect(invocation.env).not.toHaveProperty("RAVI_CONTEXT_KEY");
      expect(invocation.env.RAVI_BUNDLE).toBe(runtime.bundlePath);
      const request = decodeManagedRuntimeRebindRequest(invocation.env[MANAGED_RUNTIME_REBIND_ENV]!);
      expect(request).toEqual({
        schemaVersion: 1,
        target: runtime.target,
        previousProcesses: [{ name: "ravi", status: "online", pid: 10, createdAt: 1 }],
      });
    } finally {
      runtime.cleanup();
    }
  });

  it("deletes, recreates, verifies, and persists the managed runtime", async () => {
    const runtime = createRuntimePackage();
    try {
      const old = createRuntimePackage("3.260730.3");
      try {
        let processes: Pm2Process[] = [
          pm2Process("ravi", old.bundlePath, old.root, { pid: 10, createdAt: 1 }),
          pm2Process("ravi-channels", old.bundlePath, old.root, { pid: 20, createdAt: 1 }),
        ];
        const calls: string[] = [];
        const ok = await rebindManagedRuntimeProcesses(
          processes.map(({ name, status, pid, createdAt }) => ({ name, status, pid, createdAt: createdAt ?? null })),
          runtime.target,
          {
            bunPath: "/usr/bin/bun",
            runnerEnv: () => ({ RAVI_CHANNELS_CONSUME_OUTBOUND: "1" }),
            getProcesses: () => processes,
            run: async (_command, args, options) => {
              calls.push(args.join(" "));
              if (args[0] === "delete") {
                processes = processes.filter((process) => process.name !== args[1]);
              } else if (args[0] === "start") {
                const name = args[args.indexOf("--name") + 1] as "ravi" | "ravi-channels";
                processes.push(
                  pm2Process(name, runtime.bundlePath, runtime.root, {
                    pid: name === "ravi" ? 11 : 21,
                    createdAt: 2,
                  }),
                );
                if (name === "ravi-channels") {
                  expect(options?.env?.RAVI_CHANNELS_CONSUME_OUTBOUND).toBe("1");
                }
              }
              return { success: true, output: "" };
            },
          },
        );

        expect(ok).toBe(true);
        expect(calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual([
          "delete ravi-channels",
          "delete ravi",
          `start ${runtime.bundlePath}`,
          "start /usr/bin/bun",
          "save --force",
        ]);
      } finally {
        old.cleanup();
      }
    } finally {
      runtime.cleanup();
    }
  });
});

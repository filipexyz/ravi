import { describe, expect, it } from "bun:test";

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPm2Env, parsePm2Processes, runPm2 } from "./pm2.js";

describe("buildPm2Env", () => {
  it("overwrites retained PM2 context with empty values while preserving service settings", () => {
    const env = buildPm2Env({
      RAVI_CONTEXT_KEY: "rctx_child",
      RAVI_INTERNAL_UPDATE_RUNTIME_REBIND: "internal-request",
      RAVI_SESSION_KEY: "session_key",
      RAVI_SESSION_NAME: "main",
      RAVI_SESSION_TOKEN: "session-token",
      RAVI_SESSION_CALLBACK_URL: "https://example.invalid/session",
      RAVI_AGENT_ID: "agent-main",
      RAVI_CHANNEL: "slack",
      RAVI_ACCOUNT_ID: "account",
      RAVI_INSTANCE_ID: "instance",
      RAVI_CANONICAL_CHAT_ID: "canonical-chat",
      RAVI_CHAT_ID: "chat",
      RAVI_THREAD_ID: "thread",
      RAVI_SLACK_CONNECTION: "old-single",
      RAVI_SLACK_CONNECTIONS: "old-a,old-b",
      RAVI_SLACK_CREDENTIAL_CONNECTION: "old-credential",
      RAVI_GATEWAY_URL: "unix:///old-gateway.sock",
      RAVI_GATEWAY_INTERNAL: "1",
      RAVI_HOST_CLI_GATEWAY: "0",
      RAVI_DAEMON_RESTART_HANDOFF: "1",
      RAVI_DAEMON_RESTART_HANDOFF_WORKER: "1",
      RAVI_TASK_ID: "task-old",
      RAVI_TASK_PROFILE_ID: "profile-old",
      RAVI_TASK_SESSION: "session-old",
      RAVI_TASK_WORKSPACE: "/old-task",
      RAVI_TASK_ACTOR: "actor-old",
      RAVI_STATE_DIR: "/isolated-state",
      NATS_URL: "nats://127.0.0.1:4322",
    });

    for (const key of [
      "RAVI_CONTEXT_KEY",
      "RAVI_INTERNAL_UPDATE_RUNTIME_REBIND",
      "RAVI_SESSION_KEY",
      "RAVI_SESSION_NAME",
      "RAVI_SESSION_TOKEN",
      "RAVI_SESSION_CALLBACK_URL",
      "RAVI_AGENT_ID",
      "RAVI_CHANNEL",
      "RAVI_ACCOUNT_ID",
      "RAVI_INSTANCE_ID",
      "RAVI_CANONICAL_CHAT_ID",
      "RAVI_CHAT_ID",
      "RAVI_THREAD_ID",
      "RAVI_SLACK_CONNECTION",
      "RAVI_SLACK_CONNECTIONS",
      "RAVI_SLACK_CREDENTIAL_CONNECTION",
      "RAVI_GATEWAY_URL",
      "RAVI_GATEWAY_INTERNAL",
      "RAVI_HOST_CLI_GATEWAY",
      "RAVI_DAEMON_RESTART_HANDOFF",
      "RAVI_DAEMON_RESTART_HANDOFF_WORKER",
      "RAVI_TASK_ID",
      "RAVI_TASK_PROFILE_ID",
      "RAVI_TASK_SESSION",
      "RAVI_TASK_WORKSPACE",
      "RAVI_TASK_ACTOR",
    ]) {
      const retained = { [key]: "stale-pm2-value", ...env };
      expect(retained[key]).toBe("");
    }
    expect(env.RAVI_STATE_DIR).toBe("/isolated-state");
    expect(env.NATS_URL).toBe("nats://127.0.0.1:4322");
    expect(env.RAVI_PM2_EXECUTABLE).toBe(process.execPath);
    expect(buildPm2Env({ RAVI_PM2_EXECUTABLE: "/custom/bun" }).RAVI_PM2_EXECUTABLE).toBe("/custom/bun");
  });
});

describe("PM2 process start identity", () => {
  it("uses pm_uptime for the current PID independently of PM2 registration time", () => {
    const [process] = parsePm2Processes(
      JSON.stringify([
        {
          name: "ravi-channels",
          pid: 203,
          pm_id: 2,
          pm2_env: { status: "online", created_at: 1000, pm_uptime: 8000 },
        },
      ]),
    );
    expect(process).toMatchObject({ createdAt: 1000, startedAt: 8000 });
  });

  it("does not substitute created_at when the process start is unknown", () => {
    expect(
      parsePm2Processes(
        JSON.stringify([
          {
            name: "ravi",
            pid: 101,
            pm2_env: { status: "online", created_at: 1000 },
          },
        ]),
      )[0]?.startedAt,
    ).toBeNull();
  });
});

it("resolves PM2 before applying the pinned Bun executable PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "ravi-pm2-path-"));
  const originalPath = process.env.PATH;
  const selected = join(root, "selected");
  const pinned = join(root, "pinned");
  mkdirSync(selected);
  mkdirSync(pinned);
  for (const [directory, exitCode] of [
    [selected, 7],
    [pinned, 61],
  ] as const) {
    const executable = join(directory, "pm2");
    writeFileSync(executable, `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(executable, 0o755);
  }
  try {
    process.env.PATH = selected;
    expect(runPm2(["fixture"], { PATH: pinned, PM2_HOME: join(root, "manager") }).status).toBe(7);
    process.env.PATH = join(root, "missing");
    expect(runPm2(["fixture"], { PATH: pinned, PM2_HOME: join(root, "manager") }).status).toBe(1);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

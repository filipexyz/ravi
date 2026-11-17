import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildPm2Env } from "../pm2.js";
import {
  anchorStateDirEnv,
  getRestartReasonPath,
  resolveBootRestartReason,
  resolveHandoffStateDir,
} from "./restart-reason.js";

describe("getRestartReasonPath", () => {
  it("follows RAVI_STATE_DIR, not HOME", () => {
    expect(getRestartReasonPath({ RAVI_STATE_DIR: "/work/state", HOME: "/work/home" })).toBe(
      join("/work/state", "restart-reason.txt"),
    );
  });

  it("is ~/.ravi/restart-reason.txt when RAVI_STATE_DIR is unset", () => {
    const path = getRestartReasonPath({});
    expect(path.endsWith(join(".ravi", "restart-reason.txt"))).toBe(true);
  });
});

describe("resolveBootRestartReason", () => {
  const synthesize = () => ({ reason: "supervised_restart" });

  it("uses the reason the previous stop recorded", () => {
    const fromFile = { reason: "update" };
    expect(resolveBootRestartReason({ fromFile, fallbackSessionExists: false, synthesize })).toBe(fromFile);
  });

  it("announces a plain restart when the fallback session exists", () => {
    expect(resolveBootRestartReason({ fromFile: null, fallbackSessionExists: true, synthesize })).toEqual({
      reason: "supervised_restart",
    });
  });

  it("stays quiet on a first boot: no reason file and no session to tell", () => {
    expect(resolveBootRestartReason({ fromFile: null, fallbackSessionExists: false, synthesize })).toBeNull();
  });
});

describe("RAVI_STATE_DIR across the restart handoff", () => {
  const daemonCwd = "/ws/daemon";
  const callerCwd = "/ws/agent";

  it("anchorStateDirEnv pins a relative value to the daemon's own cwd, once", () => {
    const env: NodeJS.ProcessEnv = { RAVI_STATE_DIR: "state" };
    anchorStateDirEnv(env, daemonCwd);
    expect(env.RAVI_STATE_DIR).toBe(join(daemonCwd, "state"));
    anchorStateDirEnv(env, callerCwd);
    expect(env.RAVI_STATE_DIR).toBe(join(daemonCwd, "state"));
  });

  it("anchorStateDirEnv leaves absolute, empty and missing values alone", () => {
    const absolute: NodeJS.ProcessEnv = { RAVI_STATE_DIR: "/srv/ravi-a" };
    const empty: NodeJS.ProcessEnv = { RAVI_STATE_DIR: "" };
    const missing: NodeJS.ProcessEnv = {};
    for (const env of [absolute, empty, missing]) anchorStateDirEnv(env, daemonCwd);
    expect(absolute.RAVI_STATE_DIR).toBe("/srv/ravi-a");
    expect(empty.RAVI_STATE_DIR).toBe("");
    expect(missing.RAVI_STATE_DIR).toBeUndefined();
  });

  it("resolveHandoffStateDir anchors a relative value at the daemon cwd, never at the caller's", () => {
    const handed = resolveHandoffStateDir({ RAVI_STATE_DIR: "state" }, daemonCwd);
    expect(handed).toBe(join(daemonCwd, "state"));
    expect(handed).not.toBe(join(callerCwd, "state"));
  });

  it("resolveHandoffStateDir keeps an absolute value and stays unset for missing or empty", () => {
    expect(resolveHandoffStateDir({ RAVI_STATE_DIR: "/srv/ravi-a" }, daemonCwd)).toBe("/srv/ravi-a");
    expect(resolveHandoffStateDir({}, daemonCwd)).toBeUndefined();
    expect(resolveHandoffStateDir({ RAVI_STATE_DIR: "" }, daemonCwd)).toBeUndefined();
  });

  it("caller, worker and successor end up in the same directory, including the env pm2 start receives", () => {
    // A live daemon that predates the boot anchor: relative value, resolved against its cwd.
    const inherited = { RAVI_STATE_DIR: "state" };
    const daemonDir = join(daemonCwd, "state");

    // Caller (another cwd) hands off: the reason file and the worker env use the daemon's directory.
    const handed = resolveHandoffStateDir(inherited, daemonCwd);
    expect(getRestartReasonPath({ RAVI_STATE_DIR: handed })).toBe(join(daemonDir, "restart-reason.txt"));

    // Worker: its process env is what buildPm2Env spreads into the successor's pm2 environment.
    const before = process.env.RAVI_STATE_DIR;
    process.env.RAVI_STATE_DIR = handed;
    try {
      const pm2Env = buildPm2Env();
      expect(pm2Env.RAVI_STATE_DIR).toBe(daemonDir);
      // Successor boot: anchoring is a no-op on the absolute value it received.
      const successor: NodeJS.ProcessEnv = { RAVI_STATE_DIR: pm2Env.RAVI_STATE_DIR };
      anchorStateDirEnv(successor, daemonCwd);
      expect(getRestartReasonPath(successor)).toBe(join(daemonDir, "restart-reason.txt"));
    } finally {
      if (before === undefined) delete process.env.RAVI_STATE_DIR;
      else process.env.RAVI_STATE_DIR = before;
    }
  });

  it("with the boot anchor in place the handoff passes the absolute value verbatim", () => {
    const booted: NodeJS.ProcessEnv = { RAVI_STATE_DIR: "state" };
    anchorStateDirEnv(booted, daemonCwd);
    expect(resolveHandoffStateDir(booted, "/anywhere/else")).toBe(join(daemonCwd, "state"));
  });
});

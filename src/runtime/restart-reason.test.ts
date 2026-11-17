import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { getRestartReasonPath, resolveBootRestartReason, resolveHandoffStateDir } from "./restart-reason.js";

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

describe("resolveHandoffStateDir", () => {
  it("anchors a relative RAVI_STATE_DIR to the caller cwd, not the worker cwd", () => {
    expect(resolveHandoffStateDir({ RAVI_STATE_DIR: "state" }, "/work/caller")).toBe(join("/work/caller", "state"));
    expect(resolveHandoffStateDir({ RAVI_STATE_DIR: "../shared/state" }, "/work/caller")).toBe(
      join("/work", "shared", "state"),
    );
  });

  it("keeps an absolute value, whatever the cwd", () => {
    expect(resolveHandoffStateDir({ RAVI_STATE_DIR: "/srv/ravi-a" }, "/work/caller")).toBe("/srv/ravi-a");
  });

  it("stays unset when RAVI_STATE_DIR is missing or empty", () => {
    expect(resolveHandoffStateDir({}, "/work/caller")).toBeUndefined();
    expect(resolveHandoffStateDir({ RAVI_STATE_DIR: "" }, "/work/caller")).toBeUndefined();
  });

  it("makes caller and worker resolve the same restart-reason file from different cwds", () => {
    const callerCwd = "/work/caller";
    const handed = resolveHandoffStateDir({ RAVI_STATE_DIR: "state" }, callerCwd);
    expect(getRestartReasonPath({ RAVI_STATE_DIR: handed })).toBe(join(callerCwd, "state", "restart-reason.txt"));
  });
});

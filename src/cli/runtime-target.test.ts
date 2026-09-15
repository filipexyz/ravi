import { describe, expect, it } from "bun:test";
import { getSessionsSendRuntimeMismatchWarning, matchesLiveDaemonRuntime } from "./runtime-target.js";

describe("matchesLiveDaemonRuntime", () => {
  it("accepts an in-process gateway invocation hosted by the live daemon", () => {
    expect(
      matchesLiveDaemonRuntime({
        currentProcessPid: 4123,
        daemonProcessPid: 4123,
        cliBundlePath: "/opt/pm2/ProcessContainerForkBun.js",
        daemonBundlePath: "/repo/dist/bundle/index.js",
      }),
    ).toBe(true);
  });

  it("keeps rejecting a separate CLI process from a different bundle", () => {
    expect(
      matchesLiveDaemonRuntime({
        currentProcessPid: 5123,
        daemonProcessPid: 4123,
        cliBundlePath: "/global/dist/bundle/index.js",
        daemonBundlePath: "/repo/dist/bundle/index.js",
      }),
    ).toBe(false);
  });

  it("continues accepting a separate CLI process from the daemon bundle", () => {
    expect(
      matchesLiveDaemonRuntime({
        currentProcessPid: 5123,
        daemonProcessPid: 4123,
        cliBundlePath: "/repo/dist/bundle/index.js",
        daemonBundlePath: "/repo/dist/bundle/index.js",
      }),
    ).toBe(true);
  });

  it("remains indeterminate when neither process nor bundle can prove parity", () => {
    expect(
      matchesLiveDaemonRuntime({
        currentProcessPid: 5123,
        daemonProcessPid: null,
        cliBundlePath: null,
        daemonBundlePath: "/repo/dist/bundle/index.js",
      }),
    ).toBeNull();
  });
});

describe("getSessionsSendRuntimeMismatchWarning", () => {
  it("warns without blocking PATH CLI publish to the live daemon", () => {
    const warning = getSessionsSendRuntimeMismatchWarning({
      cliExecPath: "/usr/local/bin/ravi",
      cliBundlePath: "/global/dist/bundle/index.js",
      dbPath: "/tmp/ravi.db",
      daemon: {
        online: true,
        execPath: "/repo/dist/bundle/index.js",
        cwd: "/repo",
        matchesCli: false,
      },
      instance: null,
    });

    expect(warning).toContain("CLI/runtime mismatch detected.");
    expect(warning).toContain("sessions send still publishes to the live daemon via NATS.");
    expect(warning).toContain("this-turn transcript");
  });

  it("stays quiet when the CLI bundle matches the live daemon", () => {
    expect(
      getSessionsSendRuntimeMismatchWarning({
        cliExecPath: "/repo/bin/ravi",
        cliBundlePath: "/repo/dist/bundle/index.js",
        dbPath: "/tmp/ravi.db",
        daemon: {
          online: true,
          execPath: "/repo/dist/bundle/index.js",
          cwd: "/repo",
          matchesCli: true,
        },
        instance: null,
      }),
    ).toBeNull();
  });
});

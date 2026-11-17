import { describe, expect, it } from "bun:test";
import { resolveAccountHome } from "./account-home.js";

describe("OS account home lookup", () => {
  it.each([
    {
      platform: "darwin" as const,
      command: "/usr/bin/dscacheutil",
      args: ["-q", "user", "-a", "uid", "501"],
      stdout: "name: operator\nuid: 501\ndir: /Users/Operator Home\n\n",
    },
    {
      platform: "linux" as const,
      command: "/usr/bin/getent",
      args: ["passwd", "501"],
      stdout: "operator:x:501:501:Operator:/home/Operator Home:/bin/sh\n",
    },
  ])(
    "resolves $platform by UID with a bounded, environment-independent OS lookup",
    ({ platform, command, args, stdout }) => {
      expect(
        resolveAccountHome({
          platform,
          uid: 501,
          lookup: (actualCommand, actualArgs, options) => {
            expect(actualCommand).toBe(command);
            expect(actualArgs).toEqual([...args]);
            expect(options).toEqual({
              encoding: "utf8",
              timeout: 2_000,
              maxBuffer: 16_384,
              stdio: ["ignore", "pipe", "ignore"],
              env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
            });
            return { status: 0, stdout };
          },
        }),
      ).toBe(platform === "darwin" ? "/Users/Operator Home" : "/home/Operator Home");
    },
  );

  it.each([
    { platform: "darwin" as const, stdout: "name: operator\nuid: 502\ndir: /Users/operator\n" },
    { platform: "darwin" as const, stdout: "name: operator\nuid: 501\ndir: relative\n" },
    { platform: "darwin" as const, stdout: "uid: 501\ndir: /Users/one\n\nuid: 501\ndir: /Users/two\n" },
    { platform: "linux" as const, stdout: "operator:x:502:501:Operator:/home/operator:/bin/sh\n" },
    { platform: "linux" as const, stdout: "operator:x:501:501:Operator:relative:/bin/sh\n" },
    {
      platform: "linux" as const,
      stdout: "operator:x:501:501:Operator:/home/one:/bin/sh\nother:x:501:501:Other:/home/two:/bin/sh\n",
    },
  ])("rejects invalid or ambiguous $platform account evidence", ({ platform, stdout }) => {
    expect(resolveAccountHome({ platform, uid: 501, lookup: () => ({ status: 0, stdout }) })).toBeNull();
  });

  it("fails closed for unavailable lookups, unsupported systems and invalid UIDs", () => {
    for (const result of [
      { status: 1, stdout: "" },
      { status: null, stdout: "", error: new Error("timeout") },
    ]) {
      expect(resolveAccountHome({ platform: "linux", uid: 501, lookup: () => result })).toBeNull();
    }
    const unavailable = () => {
      throw new Error("Lookup unavailable");
    };
    expect(resolveAccountHome({ platform: "darwin", uid: 501, lookup: unavailable })).toBeNull();
    expect(resolveAccountHome({ platform: "win32", uid: 501, lookup: unavailable })).toBeNull();
    expect(resolveAccountHome({ platform: "linux", uid: -1, lookup: unavailable })).toBeNull();
  });
});

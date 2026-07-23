import { describe, expect, it } from "bun:test";
import { generateSessionName } from "./session-name.js";

describe("generateSessionName", () => {
  it("uses the group name as the canonical session name base", () => {
    expect(generateSessionName("ravi-github", { groupName: "ravi - github" })).toBe("ravi-github");
    expect(generateSessionName("dev", { groupName: "Ravi - Bugs" })).toBe("ravi-bugs");
  });

  it("lets group names take precedence over main-session naming", () => {
    expect(generateSessionName("main", { isMain: true, groupName: "ravi - dev" })).toBe("ravi-dev");
    expect(generateSessionName("main", { isMain: true })).toBe("main");
  });

  it("keeps non-group synthetic sessions prefixed by agent", () => {
    expect(generateSessionName("main", { suffix: "cron-daily-report" })).toBe("main-cron-daily-report");
    expect(generateSessionName("main", { peerKind: "dm", peerId: "5511999999999" })).toBe("main-dm-999999");
  });
});

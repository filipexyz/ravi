import { describe, expect, it } from "bun:test";
import { findShellAutomationsInAgentWorkspaces } from "./shell-workspace-exposure.js";

const HOME = "/Users/op";
const agents = [
  { id: "workflows", cwd: "~/ravi/ravi-workflows" },
  { id: "main", cwd: "/Users/op/ravi/main" },
  { id: "homeless", cwd: "~" },
];

describe("shell automations that run inside an agent workspace", () => {
  it("flags a shell trigger that cds into an agent workspace", () => {
    const found = findShellAutomationsInAgentWorkspaces(
      [{ kind: "trigger", id: "t1", shellCommand: "cd /Users/op/ravi/ravi-workflows && bun .ravi/x.ts" }],
      agents,
      HOME,
    );
    expect(found).toEqual([{ kind: "trigger", id: "t1", agentId: "workflows", path: "/Users/op/ravi/ravi-workflows" }]);
  });

  it("flags a shell cron that runs a script from an agent workspace", () => {
    const found = findShellAutomationsInAgentWorkspaces(
      [{ kind: "cron", id: "c1", shellCommand: "bun ~/ravi/main/scripts/watch.ts >> /tmp/log" }],
      agents,
      HOME,
    );
    expect(found.map((item) => [item.id, item.agentId])).toEqual([["c1", "main"]]);
  });

  it("ignores disabled automations, commands outside any workspace and a workspace at home", () => {
    const found = findShellAutomationsInAgentWorkspaces(
      [
        { kind: "cron", id: "off", enabled: false, shellCommand: "bun /Users/op/ravi/main/x.ts" },
        { kind: "cron", id: "elsewhere", shellCommand: "/usr/bin/python3 /opt/tools/report.py" },
        { kind: "trigger", id: "home", shellCommand: "cat /Users/op/notes.txt" },
      ],
      agents,
      HOME,
    );
    expect(found).toEqual([]);
  });
});

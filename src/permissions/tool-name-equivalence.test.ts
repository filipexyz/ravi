import { describe, expect, it } from "bun:test";
import { getToolNameEquivalents } from "../cli/tool-registry.js";
import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities, isWithheldByDeny } from "./capability-snapshot.js";

/**
 * Claude Code renamed its subagent tool from `Task` to `Agent`. Ravi's registry, its tool groups and the grants stored before
 * the rename say `Task`; the current Claude Code reports `Agent`; an older one still reports `Task`. A grant, or a deny, under
 * either name is one for the tool under both. Nothing else is renamed.
 */

const SUBAGENT_NAMES = ["Task", "Agent"] as const;

function grant(objectId: string, objectType = "tool"): ContextCapability {
  return { permission: "use", objectType, objectId };
}

function deny(objectId: string, objectType = "tool"): ContextCapability {
  return { permission: "deny_use", objectType, objectId };
}

function canUse(capabilities: ContextCapability[], toolName: string): boolean {
  return canWithCapabilities(capabilities, "use", "tool", toolName);
}

describe("getToolNameEquivalents", () => {
  it("names the subagent tool under both names, the asked name first", () => {
    expect(getToolNameEquivalents("Agent")).toEqual(["Agent", "Task"]);
    expect(getToolNameEquivalents("Task")).toEqual(["Task", "Agent"]);
  });

  it("leaves every other name alone", () => {
    for (const name of [
      "Bash",
      "TaskOutput",
      "TaskStop",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TodoWrite",
    ]) {
      expect(getToolNameEquivalents(name)).toEqual([name]);
    }
    expect(getToolNameEquivalents("*")).toEqual(["*"]);
    expect(getToolNameEquivalents("mcp__github__*")).toEqual(["mcp__github__*"]);
    expect(getToolNameEquivalents("")).toEqual([""]);
  });

  it("matches the name exactly: a different case or a longer name is another tool", () => {
    expect(getToolNameEquivalents("agent")).toEqual(["agent"]);
    expect(getToolNameEquivalents("TASK")).toEqual(["TASK"]);
    expect(getToolNameEquivalents("AgentX")).toEqual(["AgentX"]);
  });
});

describe("a grant of the subagent tool", () => {
  for (const granted of SUBAGENT_NAMES) {
    for (const called of SUBAGENT_NAMES) {
      it(`under ${granted} covers a call of ${called}`, () => {
        expect(canUse([grant(granted)], called)).toBe(true);
      });
    }
  }

  it("is covered through a tool group that lists Task, for both names", () => {
    // `execute` is the registry group of Bash, Task, TaskOutput and TaskStop.
    const group = [grant("execute", "toolgroup")];
    expect(canUse(group, "Task")).toBe(true);
    expect(canUse(group, "Agent")).toBe(true);
    expect(canUse(group, "Bash")).toBe(true);
    expect(canUse(group, "Read")).toBe(false);
  });

  it("is covered by a prefix pattern that matches either name", () => {
    expect(canUse([grant("Ag*")], "Task")).toBe(true);
    expect(canUse([grant("Ta*")], "Agent")).toBe(true);
    expect(canUse([grant("Ze*")], "Agent")).toBe(false);
    expect(canUse([grant("Ze*")], "Task")).toBe(false);
  });

  it("is still covered by the wildcard and by nothing when there is no grant", () => {
    for (const called of SUBAGENT_NAMES) {
      expect(canUse([grant("*")], called)).toBe(true);
      expect(canUse([], called)).toBe(false);
      expect(canUse([grant("Read"), grant("Bash")], called)).toBe(false);
    }
  });

  it("does not cover the other tools whose name starts with Task", () => {
    for (const granted of SUBAGENT_NAMES) {
      for (const other of [
        "TaskOutput",
        "TaskStop",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "TodoWrite",
        "Agents",
      ]) {
        expect(canUse([grant(granted)], other)).toBe(false);
      }
    }
  });

  it("does not make a specific grant satisfy a wildcard request", () => {
    expect(canUse([grant("Task")], "*")).toBe(false);
    expect(canUse([grant("Agent")], "*")).toBe(false);
  });

  it("renames only tool objects: an agent or a session called Agent is not the agent called Task", () => {
    const asAgent: ContextCapability[] = [{ permission: "access", objectType: "agent", objectId: "Task" }];
    expect(canWithCapabilities(asAgent, "access", "agent", "Task")).toBe(true);
    expect(canWithCapabilities(asAgent, "access", "agent", "Agent")).toBe(false);

    const asSession: ContextCapability[] = [{ permission: "access", objectType: "session", objectId: "Agent" }];
    expect(canWithCapabilities(asSession, "access", "session", "Task")).toBe(false);

    // A tool grant is not an agent grant either.
    expect(canWithCapabilities([grant("Task")], "access", "agent", "Agent")).toBe(false);
    expect(canWithCapabilities([grant("Task")], "use", "agent", "Agent")).toBe(false);
  });
});

describe("a deny of the subagent tool", () => {
  for (const denied of SUBAGENT_NAMES) {
    for (const called of SUBAGENT_NAMES) {
      it(`under ${denied} withholds a call of ${called} that the wildcard would allow`, () => {
        const capabilities = [grant("*"), deny(denied)];
        expect(canUse(capabilities, called)).toBe(false);
        expect(isWithheldByDeny(capabilities, "use", "tool", called)).toBe(true);
      });
    }
  }

  it("withholds both names from a wildcard deny too, and the other tools with them", () => {
    const capabilities = [grant("*"), deny("*")];
    for (const called of [...SUBAGENT_NAMES, "Read", "Bash"]) {
      expect(canUse(capabilities, called)).toBe(false);
    }
  });

  it("leaves the other tools alone", () => {
    const capabilities = [grant("*"), deny("Agent")];
    for (const other of ["Read", "Bash", "TaskOutput", "TaskStop", "TaskCreate", "TodoWrite"]) {
      expect(canUse(capabilities, other)).toBe(true);
    }
  });

  it("is overridden by an explicit grant under either name, as for any tool", () => {
    // An explicit, non-wildcard grant of the tool still allows it past a deny: the deny withholds what a wildcard or the
    // admin shortcut would grant. The grant counts under either name, a deny does too.
    for (const granted of SUBAGENT_NAMES) {
      for (const denied of [...SUBAGENT_NAMES, "*"]) {
        const capabilities = [grant(granted), deny(denied)];
        for (const called of SUBAGENT_NAMES) {
          expect(isWithheldByDeny(capabilities, "use", "tool", called)).toBe(false);
          expect(canUse(capabilities, called)).toBe(true);
        }
      }
      // The explicit grant covers the tool, not the rest.
      expect(canUse([grant(granted), deny("*")], "Bash")).toBe(false);
    }
  });

  it("is not overridden by a wildcard or a pattern grant", () => {
    for (const granted of ["*", "Ag*", "Ta*"]) {
      const capabilities = [grant(granted), deny("Task")];
      for (const called of SUBAGENT_NAMES) expect(canUse(capabilities, called)).toBe(false);
    }
  });

  it("reaches a tool object only", () => {
    // A deny written for an agent named Agent says nothing about the tool.
    const capabilities = [grant("*"), deny("Agent", "agent")];
    for (const called of SUBAGENT_NAMES) expect(canUse(capabilities, called)).toBe(true);
    expect(isWithheldByDeny(capabilities, "use", "agent", "Agent")).toBe(true);
    expect(isWithheldByDeny(capabilities, "use", "agent", "Task")).toBe(false);
  });
});

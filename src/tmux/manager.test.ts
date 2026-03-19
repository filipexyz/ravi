import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { SessionEntry } from "../router/types.js";
import {
  RaviTmuxManager,
  buildWatcherShellCommand,
  buildTuiShellCommand,
  tmuxPaneTitleForSession,
  type TmuxInteractiveRunner,
  parseSessionNameFromPromptTopic,
  tmuxSessionNameForAgent,
  tmuxWindowNameForAgent,
  tmuxWindowNameForSession,
  type TmuxCommandResult,
  type TmuxCommandRunner,
} from "./manager.js";

const projectRoot = process.cwd();
const now = Date.now();

function makeSessionEntry(sessionName: string, agentId = "main", updatedAt = now): SessionEntry {
  return {
    sessionKey: `agent:${agentId}:${sessionName}`,
    name: sessionName,
    agentId,
    agentCwd: `/tmp/${agentId}`,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    systemSent: false,
    abortedLastRun: false,
    compactionCount: 0,
    ephemeral: false,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("tmux manager helpers", () => {
  it("parses prompt topics into session names", () => {
    expect(parseSessionNameFromPromptTopic("ravi.session.main.prompt")).toBe("main");
    expect(parseSessionNameFromPromptTopic("ravi.session.main.response")).toBeNull();
  });

  it("builds stable tmux names for agents, windows, and panes", () => {
    expect(tmuxSessionNameForAgent("main")).toBe("ravi-main");
    expect(tmuxWindowNameForAgent("main")).toBe("main");
    expect(tmuxWindowNameForAgent("my agent")).toBe("my-agent");
    expect(tmuxWindowNameForSession("group:120363405113391144")).toBe("group-120363405113391144");
    expect(tmuxPaneTitleForSession("main-24")).toBe("main-24");
  });

  it("builds the shell command that boots a single-session TUI", () => {
    const command = buildTuiShellCommand({
      projectRoot,
      sessionName: "main",
      agentId: "main",
    });

    expect(command).toContain("bun");
    expect(command).toContain(join(projectRoot, "src/tui/index.tsx"));
    expect(command).toContain("RAVI_TMUX_AGENT=main");
    expect(command).toContain("RAVI_TMUX_SESSION=main");
  });

  it("builds the shell command that boots the watcher", () => {
    const command = buildWatcherShellCommand(projectRoot);

    expect(command).toContain("bun");
    expect(command).toContain(join(projectRoot, "src/cli/index.ts"));
    expect(command).toContain("tmux watch --sync");
  });
});

describe("RaviTmuxManager", () => {
  it("creates a tmux session/window and labels the first pane for the session", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "missing", exitCode: 1 };
        }
        if (args[0] === "list-panes") {
          return { stdout: "%1\t\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main")],
    });

    const result = await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main",
    });

    expect(result).toEqual({
      tmuxSessionName: "ravi-main",
      windowName: "main",
      paneId: "%1",
      paneTitle: "main",
      createdSession: true,
      createdWindow: true,
      createdPane: true,
      respawnedPane: false,
    });
    expect(calls[0]).toEqual(["has-session", "-t", "ravi-main"]);
    expect(calls[1]?.slice(0, 6)).toEqual(["new-session", "-d", "-s", "ravi-main", "-n", "main"]);
    expect(calls).toContainEqual(["set-window-option", "-t", "ravi-main:main", "remain-on-exit", "off"]);
    expect(calls).toContainEqual([
      "list-panes",
      "-t",
      "ravi-main:main",
      "-F",
      "#{pane_id}\t#{pane_title}\t#{pane_dead}",
    ]);
    expect(calls).toContainEqual(["select-pane", "-t", "%1", "-T", "main"]);
    expect(calls).toContainEqual(["select-layout", "-t", "ravi-main:main", "tiled"]);
  });

  it("creates a new pane for another session in the same agent window", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return { stdout: "%1\tmain\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "split-window") {
          return { stdout: "%2\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main"), makeSessionEntry("main-24")],
    });

    const result = await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main-24",
    });

    expect(result).toEqual({
      tmuxSessionName: "ravi-main",
      windowName: "main",
      paneId: "%2",
      paneTitle: "main-24",
      createdSession: false,
      createdWindow: false,
      createdPane: true,
      respawnedPane: false,
    });
    const splitCall = calls.find((args) => args[0] === "split-window");
    expect(splitCall?.slice(0, 7)).toEqual(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "ravi-main:main"]);
    expect(splitCall?.[7]).toContain("main-24");
    expect(calls).toContainEqual(["select-pane", "-t", "%2", "-T", "main-24"]);
    expect(calls).toContainEqual(["select-layout", "-t", "ravi-main:main", "tiled"]);
  });

  it("reuses an existing live pane for the same session", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return {
            stdout: "%1\tmain\t0\n%2\tmain-24\t0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main"), makeSessionEntry("main-24")],
    });

    const result = await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main-24",
    });

    expect(result).toEqual({
      tmuxSessionName: "ravi-main",
      windowName: "main",
      paneId: "%2",
      paneTitle: "main-24",
      createdSession: false,
      createdWindow: false,
      createdPane: false,
      respawnedPane: false,
    });
    expect(calls.some((args) => args[0] === "split-window")).toBe(false);
  });

  it("respawns a dead pane for the same session", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return {
            stdout: "%1\tmain\t0\n%2\tmain-24\t1\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main"), makeSessionEntry("main-24")],
    });

    const result = await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main-24",
    });

    expect(result).toEqual({
      tmuxSessionName: "ravi-main",
      windowName: "main",
      paneId: "%2",
      paneTitle: "main-24",
      createdSession: false,
      createdWindow: false,
      createdPane: false,
      respawnedPane: true,
    });
    const respawnCall = calls.find((args) => args[0] === "respawn-pane");
    expect(respawnCall?.slice(0, 4)).toEqual(["respawn-pane", "-k", "-t", "%2"]);
    expect(respawnCall?.[4]).toContain("main-24");
    expect(calls).toContainEqual(["select-pane", "-t", "%2", "-T", "main-24"]);
  });

  it("prunes legacy extra windows for the same agent workspace", async () => {
    const calls: string[][] = [];
    let listWindowsCount = 0;
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          listWindowsCount += 1;
          if (listWindowsCount === 1) {
            return {
              stdout: "main\t0\nlegacy-1\t0\nlegacy-2\t0\n",
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: "main\t0\nlegacy-1\t0\nlegacy-2\t0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "list-panes") {
          return { stdout: "%1\tmain\t0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main")],
    });

    await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main",
    });

    expect(calls).toContainEqual(["kill-window", "-t", "ravi-main:legacy-1"]);
    expect(calls).toContainEqual(["kill-window", "-t", "ravi-main:legacy-2"]);
  });

  it("prunes stale panes outside the recent session window", async () => {
    const calls: string[][] = [];
    const staleTimestamp = now - 2 * 24 * 60 * 60 * 1000;
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return {
            stdout: "%1\tmain\t0\n%2\tmain-24\t0\n%3\tvery-old\t0\n%4\t\t0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [
        makeSessionEntry("main", "main", now),
        makeSessionEntry("main-24", "main", now - 1000),
        makeSessionEntry("very-old", "main", staleTimestamp),
      ],
    });

    await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main",
    });

    expect(calls).toContainEqual(["kill-pane", "-t", "%3"]);
    expect(calls).toContainEqual(["kill-pane", "-t", "%4"]);
  });

  it("always kills dead panes even when the session title is still allowed", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return {
            stdout: "%1\tmain\t0\n%2\tmain-24\t1\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main"), makeSessionEntry("main-24")],
    });

    await manager.ensureWindowForResolvedSession({
      agentId: "main",
      sessionName: "main",
    });

    expect(calls).toContainEqual(["kill-pane", "-t", "%2"]);
  });

  it("creates the detached watcher control window", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "missing", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({
      runner,
      projectRoot,
      listSessionEntries: () => [makeSessionEntry("main-24")],
    });
    const result = await manager.ensureWatcherRunning();

    expect(result).toEqual({
      tmuxSessionName: "ravi-control",
      windowName: "watch",
      createdSession: true,
      createdWindow: true,
      respawnedWindow: false,
    });
    expect(calls[0]).toEqual(["has-session", "-t", "ravi-control"]);
    expect(calls[1]?.slice(0, 6)).toEqual(["new-session", "-d", "-s", "ravi-control", "-n", "watch"]);
    expect(calls).toContainEqual(["set-window-option", "-t", "ravi-control:watch", "remain-on-exit", "on"]);
  });

  it("can restart the watcher window when already running", async () => {
    const calls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        calls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return {
            stdout: "watch\t0\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const manager = new RaviTmuxManager({ runner, projectRoot });
    const result = await manager.ensureWatcherRunning({ restartIfRunning: true });

    expect(result).toEqual({
      tmuxSessionName: "ravi-control",
      windowName: "watch",
      createdSession: false,
      createdWindow: false,
      respawnedWindow: true,
    });
    const respawnCall = calls.find((args) => args[0] === "respawn-window");
    expect(respawnCall?.slice(0, 4)).toEqual(["respawn-window", "-k", "-t", "ravi-control:watch"]);
    expect(respawnCall?.[4]).toContain("tmux watch --sync");
  });

  it("attaches through an interactive tmux client outside tmux", async () => {
    const runnerCalls: string[][] = [];
    const interactiveCalls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        runnerCalls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return { stdout: "%2\tmain-24\t0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const interactiveRunner: TmuxInteractiveRunner = {
      async run(args: string[]): Promise<void> {
        interactiveCalls.push(args);
      },
    };

    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;

    try {
      const manager = new RaviTmuxManager({
        runner,
        interactiveRunner,
        projectRoot,
        listSessionEntries: () => [makeSessionEntry("main-24")],
      });

      await manager.attach("main", "main-24");

      expect(runnerCalls).toContainEqual(["select-window", "-t", "ravi-main:main"]);
      expect(runnerCalls).toContainEqual(["select-pane", "-t", "%2"]);
      expect(interactiveCalls).toEqual([["attach-session", "-t", "ravi-main"]]);
    } finally {
      if (previousTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = previousTmux;
      }
    }
  });

  it("switches tmux client instead of spawning attach when already inside tmux", async () => {
    const runnerCalls: string[][] = [];
    const interactiveCalls: string[][] = [];
    const runner: TmuxCommandRunner = {
      async run(args: string[]): Promise<TmuxCommandResult> {
        runnerCalls.push(args);
        if (args[0] === "has-session") {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-windows") {
          return { stdout: "main\t0\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "list-panes") {
          return { stdout: "%2\tmain-24\t0\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const interactiveRunner: TmuxInteractiveRunner = {
      async run(args: string[]): Promise<void> {
        interactiveCalls.push(args);
      },
    };

    const previousTmux = process.env.TMUX;
    process.env.TMUX = "/tmp/tmux-test";

    try {
      const manager = new RaviTmuxManager({
        runner,
        interactiveRunner,
        projectRoot,
        listSessionEntries: () => [makeSessionEntry("main-24")],
      });

      await manager.attach("main", "main-24");

      expect(runnerCalls).toContainEqual(["select-pane", "-t", "%2"]);
      expect(runnerCalls).toContainEqual(["switch-client", "-t", "ravi-main:main"]);
      expect(interactiveCalls).toHaveLength(0);
    } finally {
      if (previousTmux === undefined) {
        delete process.env.TMUX;
      } else {
        process.env.TMUX = previousTmux;
      }
    }
  });
});

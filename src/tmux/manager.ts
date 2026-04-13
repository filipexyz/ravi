import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { subscribe } from "../nats.js";
import { getAgent } from "../router/config.js";
import { ensureUniqueName, generateSessionName } from "../router/index.js";
import type { SessionEntry } from "../router/types.js";
import { getMainSession, getOrCreateSession, listSessions, resolveSession } from "../router/sessions.js";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);
const log = logger.child("tmux");
const DEFAULT_SOCKET_NAME = "ravi";
const TOPIC_PREFIX = "ravi.session.";
const PROMPT_SUFFIX = ".prompt";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = join(__dirname, "../..");
const WATCHER_TMUX_SESSION = "ravi-control";
const WATCHER_WINDOW_NAME = "watch";
const RECENT_PANE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_PANES_PER_AGENT = 8;

export interface TmuxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TmuxCommandRunner {
  run(args: string[]): Promise<TmuxCommandResult>;
}

export interface TmuxInteractiveRunner {
  run(args: string[]): Promise<void>;
}

export interface ManagedWindowState {
  name: string;
  paneDead: boolean;
}

export interface ManagedPaneState {
  id: string;
  title: string;
  paneDead: boolean;
}

export interface EnsureWindowResult {
  tmuxSessionName: string;
  windowName: string;
  createdSession: boolean;
  createdWindow: boolean;
  respawnedWindow: boolean;
}

export interface EnsurePaneResult {
  tmuxSessionName: string;
  windowName: string;
  paneId: string;
  paneTitle: string;
  createdSession: boolean;
  createdWindow: boolean;
  createdPane: boolean;
  respawnedPane: boolean;
}

export interface RaviTmuxManagerOptions {
  socketName?: string;
  runner?: TmuxCommandRunner;
  interactiveRunner?: TmuxInteractiveRunner;
  projectRoot?: string;
  listSessionEntries?: () => SessionEntry[];
}

interface ManagedSessionRef {
  agentId: string;
  sessionName: string;
}

export class RaviTmuxManager {
  private readonly socketName: string;
  private readonly runner: TmuxCommandRunner;
  private readonly interactiveRunner: TmuxInteractiveRunner;
  private readonly projectRoot: string;
  private readonly listSessionEntries: () => SessionEntry[];

  constructor(options: RaviTmuxManagerOptions = {}) {
    this.socketName = options.socketName ?? DEFAULT_SOCKET_NAME;
    this.runner = options.runner ?? createTmuxRunner(this.socketName);
    this.interactiveRunner = options.interactiveRunner ?? createInteractiveTmuxRunner(this.socketName);
    this.projectRoot = options.projectRoot ?? DEFAULT_PROJECT_ROOT;
    this.listSessionEntries = options.listSessionEntries ?? listSessions;
  }

  async watch(options: { syncExisting?: boolean } = {}): Promise<void> {
    if (options.syncExisting) {
      await this.syncExistingSessions();
    }

    for await (const event of subscribe("ravi.session.*.prompt")) {
      const sessionName = parseSessionNameFromPromptTopic(event.topic);
      if (!sessionName) {
        continue;
      }

      try {
        const result = await this.ensureWindowForSessionName(sessionName);
        if (result) {
          log.info("Ensured tmux pane for session", {
            sessionName,
            tmuxSessionName: result.tmuxSessionName,
            windowName: result.windowName,
            paneId: result.paneId,
            paneTitle: result.paneTitle,
            createdSession: result.createdSession,
            createdWindow: result.createdWindow,
            createdPane: result.createdPane,
            respawnedPane: result.respawnedPane,
          });
        }
      } catch (error) {
        log.warn("Failed to ensure tmux pane for prompt", {
          sessionName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async syncExistingSessions(): Promise<void> {
    const sessions = this.listRecentSessionsForSync();
    for (const session of sessions) {
      const sessionName = session.name ?? session.sessionKey;
      try {
        await this.ensureWindowForResolvedSession({
          agentId: session.agentId,
          sessionName,
        });
      } catch (error) {
        log.warn("Failed to sync tmux workspace for existing session", {
          sessionName,
          agentId: session.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async ensureWindowForSessionName(nameOrKey: string): Promise<EnsurePaneResult | null> {
    const session = resolveSession(nameOrKey);
    if (!session) {
      return null;
    }

    return this.ensureWindowForResolvedSession({
      agentId: session.agentId,
      sessionName: session.name ?? session.sessionKey,
    });
  }

  async openAgentWindow(agentId: string, sessionName?: string): Promise<EnsurePaneResult> {
    const resolved = sessionName ? resolveSession(sessionName) : null;
    if (resolved && resolved.agentId !== agentId) {
      throw new Error(`Session '${sessionName}' belongs to agent '${resolved.agentId}', not '${agentId}'`);
    }

    const effectiveSessionName =
      resolved?.name ?? resolved?.sessionKey ?? this.ensureMainRaviSession(agentId).name ?? `agent:${agentId}:main`;

    return this.ensureWindowForResolvedSession({
      agentId,
      sessionName: effectiveSessionName,
    });
  }

  async ensureWatcherRunning(options: { restartIfRunning?: boolean } = {}): Promise<EnsureWindowResult> {
    return this.ensureShellWindow({
      tmuxSessionName: WATCHER_TMUX_SESSION,
      windowName: WATCHER_WINDOW_NAME,
      shellCommand: buildWatcherShellCommand(this.projectRoot),
      restartIfRunning: options.restartIfRunning ?? false,
      remainOnExit: true,
    });
  }

  async attach(agentId: string, sessionName?: string): Promise<void> {
    const ensured = await this.openAgentWindow(agentId, sessionName);
    await this.selectWindow(ensured.tmuxSessionName, ensured.windowName);
    await this.selectPane(ensured.paneId);
    if (process.env.TMUX) {
      await this.runChecked(
        ["switch-client", "-t", `${ensured.tmuxSessionName}:${ensured.windowName}`],
        "switch tmux client",
      );
      return;
    }
    await this.interactiveRunner.run(["attach-session", "-t", ensured.tmuxSessionName]);
  }

  async listManagedSessions(): Promise<Array<{ tmuxSessionName: string; windows: ManagedWindowState[] }>> {
    const sessionNames = await this.listTmuxSessions();
    const output: Array<{ tmuxSessionName: string; windows: ManagedWindowState[] }> = [];

    for (const tmuxSessionName of sessionNames) {
      if (!tmuxSessionName.startsWith("ravi-")) {
        continue;
      }

      output.push({
        tmuxSessionName,
        windows: await this.listWindows(tmuxSessionName),
      });
    }

    return output;
  }

  async ensureWindowForResolvedSession(ref: ManagedSessionRef): Promise<EnsurePaneResult> {
    const tmuxSessionName = tmuxSessionNameForAgent(ref.agentId);
    const windowName = tmuxWindowNameForAgent(ref.agentId);
    const paneTitle = tmuxPaneTitleForSession(ref.sessionName);
    const windowResult = await this.ensureShellWindow({
      tmuxSessionName,
      windowName,
      shellCommand: buildTuiShellCommand({
        projectRoot: this.projectRoot,
        sessionName: ref.sessionName,
        agentId: ref.agentId,
      }),
      remainOnExit: false,
    });
    await this.pruneAgentWindows(tmuxSessionName, windowName);

    if (windowResult.createdSession || windowResult.createdWindow || windowResult.respawnedWindow) {
      const primaryPane = await this.labelPrimaryPane(tmuxSessionName, windowName, paneTitle);
      await this.pruneAgentPanes(tmuxSessionName, windowName, this.getAllowedPaneTitles(ref.agentId, paneTitle));
      return {
        tmuxSessionName,
        windowName,
        paneId: primaryPane.id,
        paneTitle,
        createdSession: windowResult.createdSession,
        createdWindow: windowResult.createdWindow,
        createdPane: windowResult.createdSession || windowResult.createdWindow,
        respawnedPane: windowResult.respawnedWindow,
      };
    }

    const result = await this.ensureSessionPane({
      tmuxSessionName,
      windowName,
      paneTitle,
      shellCommand: buildTuiShellCommand({
        projectRoot: this.projectRoot,
        sessionName: ref.sessionName,
        agentId: ref.agentId,
      }),
    });
    await this.pruneAgentPanes(tmuxSessionName, windowName, this.getAllowedPaneTitles(ref.agentId, paneTitle));
    return result;
  }

  private async hasTmuxSession(tmuxSessionName: string): Promise<boolean> {
    const result = await this.runner.run(["has-session", "-t", tmuxSessionName]);
    return result.exitCode === 0;
  }

  private async ensureShellWindow(input: {
    tmuxSessionName: string;
    windowName: string;
    shellCommand: string;
    restartIfRunning?: boolean;
    remainOnExit: boolean;
  }): Promise<EnsureWindowResult> {
    const hasSession = await this.hasTmuxSession(input.tmuxSessionName);
    if (!hasSession) {
      let sawDuplicateSession = false;
      try {
        await this.runChecked(
          ["new-session", "-d", "-s", input.tmuxSessionName, "-n", input.windowName, input.shellCommand],
          "create tmux session",
        );
      } catch (error) {
        if (!isDuplicateTmuxError(error, "session")) {
          throw error;
        }
        sawDuplicateSession = true;
      }
      if (sawDuplicateSession) {
        if (await this.hasTmuxSession(input.tmuxSessionName)) {
          const windows = await this.listWindows(input.tmuxSessionName);
          if (windows.some((entry) => entry.name === input.windowName)) {
            await this.setRemainOnExit(input.tmuxSessionName, input.windowName, input.remainOnExit);
            return {
              tmuxSessionName: input.tmuxSessionName,
              windowName: input.windowName,
              createdSession: false,
              createdWindow: false,
              respawnedWindow: false,
            };
          }
        } else {
          throw new Error(`Failed to create tmux session: ${input.tmuxSessionName}`);
        }
      }
      await this.setRemainOnExit(input.tmuxSessionName, input.windowName, input.remainOnExit);
      return {
        tmuxSessionName: input.tmuxSessionName,
        windowName: input.windowName,
        createdSession: !sawDuplicateSession,
        createdWindow: !sawDuplicateSession,
        respawnedWindow: false,
      };
    }

    const windows = await this.listWindows(input.tmuxSessionName);
    const existingWindow = windows.find((entry) => entry.name === input.windowName);
    if (!existingWindow) {
      try {
        await this.runChecked(
          ["new-window", "-d", "-t", input.tmuxSessionName, "-n", input.windowName, input.shellCommand],
          "create tmux window",
        );
      } catch (error) {
        if (!isDuplicateTmuxError(error, "window")) {
          throw error;
        }
      }
      const nextWindows = await this.listWindows(input.tmuxSessionName);
      if (!nextWindows.some((entry) => entry.name === input.windowName)) {
        throw new Error(`Failed to create tmux window: ${input.tmuxSessionName}:${input.windowName}`);
      }
      await this.setRemainOnExit(input.tmuxSessionName, input.windowName, input.remainOnExit);
      return {
        tmuxSessionName: input.tmuxSessionName,
        windowName: input.windowName,
        createdSession: false,
        createdWindow: true,
        respawnedWindow: false,
      };
    }

    await this.setRemainOnExit(input.tmuxSessionName, input.windowName, input.remainOnExit);

    if (input.restartIfRunning) {
      await this.runChecked(
        ["respawn-window", "-k", "-t", `${input.tmuxSessionName}:${input.windowName}`, input.shellCommand],
        "restart tmux window",
      );
      return {
        tmuxSessionName: input.tmuxSessionName,
        windowName: input.windowName,
        createdSession: false,
        createdWindow: false,
        respawnedWindow: true,
      };
    }

    if (existingWindow.paneDead) {
      await this.runChecked(
        ["respawn-window", "-k", "-t", `${input.tmuxSessionName}:${input.windowName}`, input.shellCommand],
        "respawn tmux window",
      );
      return {
        tmuxSessionName: input.tmuxSessionName,
        windowName: input.windowName,
        createdSession: false,
        createdWindow: false,
        respawnedWindow: true,
      };
    }

    return {
      tmuxSessionName: input.tmuxSessionName,
      windowName: input.windowName,
      createdSession: false,
      createdWindow: false,
      respawnedWindow: false,
    };
  }

  private async selectWindow(tmuxSessionName: string, windowName: string): Promise<void> {
    await this.runChecked(["select-window", "-t", `${tmuxSessionName}:${windowName}`], "select tmux window");
  }

  private async selectPane(paneId: string): Promise<void> {
    await this.runChecked(["select-pane", "-t", paneId], "select tmux pane");
  }

  private async setRemainOnExit(tmuxSessionName: string, windowName: string, enabled: boolean): Promise<void> {
    await this.runChecked(
      ["set-window-option", "-t", `${tmuxSessionName}:${windowName}`, "remain-on-exit", enabled ? "on" : "off"],
      "configure tmux remain-on-exit",
    );
  }

  private async setPaneTitle(paneId: string, title: string): Promise<void> {
    await this.runChecked(["select-pane", "-t", paneId, "-T", title], "set tmux pane title");
  }

  private async selectTiledLayout(tmuxSessionName: string, windowName: string): Promise<void> {
    await this.runChecked(["select-layout", "-t", `${tmuxSessionName}:${windowName}`, "tiled"], "select tmux layout");
  }

  private async labelPrimaryPane(
    tmuxSessionName: string,
    windowName: string,
    paneTitle: string,
  ): Promise<ManagedPaneState> {
    const panes = await this.listPanes(tmuxSessionName, windowName);
    const primaryPane = panes[0];
    if (!primaryPane) {
      throw new Error(`Failed to resolve primary tmux pane: ${tmuxSessionName}:${windowName}`);
    }
    await this.setPaneTitle(primaryPane.id, paneTitle);
    await this.selectTiledLayout(tmuxSessionName, windowName);
    return {
      ...primaryPane,
      title: paneTitle,
    };
  }

  private async ensureSessionPane(input: {
    tmuxSessionName: string;
    windowName: string;
    paneTitle: string;
    shellCommand: string;
  }): Promise<EnsurePaneResult> {
    const panes = await this.listPanes(input.tmuxSessionName, input.windowName);
    const existingPane = panes.find((pane) => pane.title === input.paneTitle);
    if (existingPane) {
      if (existingPane.paneDead) {
        await this.runChecked(["respawn-pane", "-k", "-t", existingPane.id, input.shellCommand], "respawn tmux pane");
        await this.setPaneTitle(existingPane.id, input.paneTitle);
        await this.selectTiledLayout(input.tmuxSessionName, input.windowName);
        return {
          tmuxSessionName: input.tmuxSessionName,
          windowName: input.windowName,
          paneId: existingPane.id,
          paneTitle: input.paneTitle,
          createdSession: false,
          createdWindow: false,
          createdPane: false,
          respawnedPane: true,
        };
      }

      return {
        tmuxSessionName: input.tmuxSessionName,
        windowName: input.windowName,
        paneId: existingPane.id,
        paneTitle: input.paneTitle,
        createdSession: false,
        createdWindow: false,
        createdPane: false,
        respawnedPane: false,
      };
    }

    const splitResult = await this.runChecked(
      [
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        `${input.tmuxSessionName}:${input.windowName}`,
        input.shellCommand,
      ],
      "create tmux pane",
    );
    const paneId = splitResult.stdout.trim();
    if (!paneId) {
      throw new Error(`Failed to resolve new tmux pane id: ${input.tmuxSessionName}:${input.windowName}`);
    }

    await this.setPaneTitle(paneId, input.paneTitle);
    await this.selectTiledLayout(input.tmuxSessionName, input.windowName);

    return {
      tmuxSessionName: input.tmuxSessionName,
      windowName: input.windowName,
      paneId,
      paneTitle: input.paneTitle,
      createdSession: false,
      createdWindow: false,
      createdPane: true,
      respawnedPane: false,
    };
  }

  private async pruneAgentWindows(tmuxSessionName: string, keepWindowName: string): Promise<void> {
    const windows = await this.listWindows(tmuxSessionName);
    for (const window of windows) {
      if (window.name === keepWindowName) {
        continue;
      }
      await this.runChecked(["kill-window", "-t", `${tmuxSessionName}:${window.name}`], "prune legacy tmux window");
    }
  }

  private async pruneAgentPanes(
    tmuxSessionName: string,
    windowName: string,
    allowedPaneTitles: ReadonlySet<string>,
  ): Promise<void> {
    const panes = await this.listPanes(tmuxSessionName, windowName);
    const seenTitles = new Set<string>();

    for (const pane of panes) {
      if (pane.paneDead) {
        await this.runChecked(["kill-pane", "-t", pane.id], "prune dead tmux pane");
        continue;
      }
      const isAllowed = allowedPaneTitles.has(pane.title);
      const isDuplicate = pane.title.length > 0 && seenTitles.has(pane.title);
      if (isAllowed && !isDuplicate) {
        seenTitles.add(pane.title);
        continue;
      }
      await this.runChecked(["kill-pane", "-t", pane.id], "prune legacy tmux pane");
    }

    await this.selectTiledLayout(tmuxSessionName, windowName);
  }

  private async runChecked(args: string[], action: string): Promise<TmuxCommandResult> {
    const result = await this.runner.run(args);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      throw new Error(stderr.length > 0 ? `Failed to ${action}: ${stderr}` : `Failed to ${action}`);
    }
    return result;
  }

  private async listTmuxSessions(): Promise<string[]> {
    const result = await this.runner.run(["list-sessions", "-F", "#{session_name}"]);
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private async listWindows(tmuxSessionName: string): Promise<ManagedWindowState[]> {
    const result = await this.runner.run(["list-windows", "-t", tmuxSessionName, "-F", "#{window_name}\t#{pane_dead}"]);
    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, paneDead] = line.split("\t");
        return {
          name: name ?? "",
          paneDead: paneDead === "1",
        };
      });
  }

  private async listPanes(tmuxSessionName: string, windowName: string): Promise<ManagedPaneState[]> {
    const result = await this.runner.run([
      "list-panes",
      "-t",
      `${tmuxSessionName}:${windowName}`,
      "-F",
      "#{pane_id}\t#{pane_title}\t#{pane_dead}",
    ]);
    if (result.exitCode !== 0) {
      return [];
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, title, paneDead] = line.split("\t");
        return {
          id: id ?? "",
          title: title ?? "",
          paneDead: paneDead === "1",
        };
      });
  }

  private ensureMainRaviSession(agentId: string): SessionEntry {
    const existing = getMainSession(agentId);
    if (existing) {
      return existing;
    }

    const agent = getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const baseName = generateSessionName(agentId, { isMain: true });
    const name = ensureUniqueName(baseName);
    return getOrCreateSession(`agent:${agentId}:main`, agentId, agent.cwd, { name });
  }

  private getAllowedPaneTitles(agentId: string, targetPaneTitle: string): Set<string> {
    const allowed = new Set<string>([targetPaneTitle]);
    for (const session of this.listRecentSessionsForAgent(agentId)) {
      allowed.add(tmuxPaneTitleForSession(session.name ?? session.sessionKey));
    }
    return allowed;
  }

  private listRecentSessionsForSync(): SessionEntry[] {
    const grouped = new Map<string, SessionEntry[]>();
    for (const session of this.listSessionEntries()) {
      if (Date.now() - session.updatedAt > RECENT_PANE_WINDOW_MS) {
        continue;
      }
      const bucket = grouped.get(session.agentId) ?? [];
      bucket.push(session);
      grouped.set(session.agentId, bucket);
    }

    const sessions: SessionEntry[] = [];
    for (const bucket of grouped.values()) {
      bucket.sort((a, b) => b.updatedAt - a.updatedAt);
      sessions.push(...bucket.slice(0, MAX_RECENT_PANES_PER_AGENT));
    }
    return sessions;
  }

  private listRecentSessionsForAgent(agentId: string): SessionEntry[] {
    return this.listSessionEntries()
      .filter((session) => session.agentId === agentId && Date.now() - session.updatedAt <= RECENT_PANE_WINDOW_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_RECENT_PANES_PER_AGENT);
  }
}

export function parseSessionNameFromPromptTopic(topic: string): string | null {
  if (!topic.startsWith(TOPIC_PREFIX) || !topic.endsWith(PROMPT_SUFFIX)) {
    return null;
  }
  return topic.slice(TOPIC_PREFIX.length, -PROMPT_SUFFIX.length) || null;
}

export function tmuxSessionNameForAgent(agentId: string): string {
  return `ravi-${sanitizeTmuxIdentifier(agentId, "agent")}`;
}

export function tmuxWindowNameForAgent(agentId: string): string {
  return sanitizeTmuxIdentifier(agentId, "agent");
}

export function tmuxPaneTitleForSession(sessionName: string): string {
  return sessionName;
}

export function tmuxWindowNameForSession(sessionName: string): string {
  return sanitizeTmuxIdentifier(sessionName, "session");
}

export function buildTuiShellCommand(input: { projectRoot: string; sessionName: string; agentId: string }): string {
  const tuiPath = resolveTuiEntry(input.projectRoot);
  return [
    "cd",
    shellEscape(input.projectRoot),
    "&&",
    "exec",
    "env",
    `RAVI_TMUX_AGENT=${shellEscape(input.agentId)}`,
    `RAVI_TMUX_SESSION=${shellEscape(input.sessionName)}`,
    "bun",
    shellEscape(tuiPath),
    shellEscape(input.sessionName),
  ].join(" ");
}

export function buildWatcherShellCommand(projectRoot: string): string {
  const cliPath = resolveCliEntry(projectRoot);
  return ["cd", shellEscape(projectRoot), "&&", "exec", "bun", shellEscape(cliPath), "tmux", "watch", "--sync"].join(
    " ",
  );
}

function resolveTuiEntry(projectRoot: string): string {
  const sourcePath = join(projectRoot, "src/tui/index.tsx");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }
  return join(projectRoot, "dist/tui/index.tsx");
}

function resolveCliEntry(projectRoot: string): string {
  const sourcePath = join(projectRoot, "src/cli/index.ts");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }
  return join(projectRoot, "dist/bundle/index.js");
}

function sanitizeTmuxIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[:\s/\\]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (normalized.length > 0 && normalized.length <= 48) {
    return normalized;
  }

  const shortHash = createHash("sha1").update(value).digest("hex").slice(0, 6);
  const base = normalized.slice(0, 40) || fallback;
  return `${base}-${shortHash}`;
}

function shellEscape(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function isDuplicateTmuxError(error: unknown, target: "session" | "window"): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes(`duplicate ${target}`) ||
    message.includes(`existing ${target}`) ||
    message.includes("already exists")
  );
}

export function createTmuxRunner(socketName = DEFAULT_SOCKET_NAME): TmuxCommandRunner {
  return {
    async run(args: string[]): Promise<TmuxCommandResult> {
      try {
        const { stdout, stderr } = await execFileAsync("tmux", ["-L", socketName, ...args], {
          encoding: "utf8",
        });
        return {
          stdout,
          stderr,
          exitCode: 0,
        };
      } catch (error: any) {
        return {
          stdout: typeof error?.stdout === "string" ? error.stdout : "",
          stderr: typeof error?.stderr === "string" ? error.stderr : error instanceof Error ? error.message : "",
          exitCode: typeof error?.code === "number" ? error.code : 1,
        };
      }
    },
  };
}

export function createInteractiveTmuxRunner(socketName = DEFAULT_SOCKET_NAME): TmuxInteractiveRunner {
  return {
    async run(args: string[]): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("tmux", ["-L", socketName, ...args], {
          stdio: "inherit",
        });
        child.on("error", reject);
        child.on("exit", (code) => {
          if ((code ?? 0) !== 0) {
            reject(new Error(`tmux ${args[0] ?? "command"} exited with code ${code ?? 0}`));
            return;
          }
          resolve();
        });
      });
    },
  };
}

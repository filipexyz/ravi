/**
 * The stdio transport of the MCP gateway (spec mcp, Gateway).
 *
 * The SDK's own `StdioClientTransport` adds HOME, LOGNAME, SHELL, TERM and
 * USER of the daemon to every child, whatever environment it is given. A
 * registered stdio server gets exactly the environment the gateway hands it
 * (PATH plus that server's declared keys), so the gateway spawns its children
 * itself. The child runs in its own process group, and closing the transport
 * stops the whole group, so a launcher (`npx`, a shell wrapper) cannot leave
 * the real server running. stderr is discarded: a server may print anything
 * there, including the values it was given.
 */

import { type ChildProcess, spawn } from "node:child_process";

import { type JSONRPCMessage, ReadBuffer, serializeMessage, type Transport } from "@modelcontextprotocol/client";

export interface McpStdioChildParams {
  command: string;
  args: readonly string[];
  /** The complete child environment; nothing of the daemon's is added. */
  env: Record<string, string>;
  cwd: string;
  /** How long a closing child gets after stdin ends, and again after SIGTERM. */
  closeGraceMs?: number;
}

const DEFAULT_CLOSE_GRACE_MS = 2_000;
/**
 * A gateway stop (daemon shutdown) gives a child no stdin-EOF grace: its group
 * gets SIGTERM at once and SIGKILL this long after, so the whole stop fits
 * inside the gateway's own stop bound.
 */
export const MCP_STDIO_SHUTDOWN_KILL_MS = 500;

export class McpStdioChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private exited: Promise<void> | undefined;
  private closedNotified = false;
  /** The one close in progress: every caller waits for the whole group to be gone. */
  private closing: Promise<void> | null = null;
  /** Set by `terminate()`: the close in progress (or the next one) skips the grace sequence. */
  private terminating = false;
  private wakeTerminate: (() => void) | null = null;
  private readonly terminateRequested = new Promise<void>((resolve) => {
    this.wakeTerminate = resolve;
  });

  constructor(private readonly params: McpStdioChildParams) {}

  /** The child's pid while it runs. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    if (this.child) throw new Error("The MCP stdio transport is already started.");
    // Closed before it started (a gateway that stopped while the connect was opening): spawn nothing.
    if (this.closing) return Promise.reject(new Error("The MCP stdio transport is closed."));
    return new Promise((resolve, reject) => {
      let spawned = false;
      const child = spawn(this.params.command, [...this.params.args], {
        env: { ...this.params.env },
        cwd: this.params.cwd,
        stdio: ["pipe", "pipe", "ignore"],
        shell: false,
        detached: true,
        windowsHide: true,
      });
      this.child = child;
      this.exited = new Promise((done) => {
        child.once("exit", () => done());
        child.once("error", () => done());
      });
      child.once("error", (error) => {
        if (!spawned) {
          this.child = undefined;
          // no-cause: spawn errors name the command only; they are rethrown as they are.
          reject(error);
          return;
        }
        this.onerror?.(error);
      });
      child.once("spawn", () => {
        spawned = true;
        if (this.closing) {
          // Closed while the child was spawning: that close stops it; the start fails.
          reject(new Error("The MCP stdio transport is closed."));
          return;
        }
        resolve();
      });
      child.once("close", () => {
        if (this.child === child) this.child = undefined;
        this.notifyClosed();
      });
      child.stdin?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("error", (error) => this.onerror?.(error));
      child.stdout?.on("data", (chunk: Buffer) => {
        try {
          this.readBuffer.append(chunk);
          for (;;) {
            const message = this.readBuffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          }
        } catch (error) {
          this.onerror?.(
            error instanceof Error ? error : new Error("The MCP stdio server sent an unreadable message."),
          );
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error("The MCP stdio server is not running."));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once("drain", () => resolve());
    });
  }

  /**
   * Stop the child's whole group. Every call waits for the same close, so a
   * second caller (the SDK closing on a timed-out connect, then the gateway)
   * never returns while the child may still run.
   */
  close(): Promise<void> {
    if (!this.closing) {
      this.closing = (async () => {
        const child = this.child;
        this.child = undefined;
        if (child) await this.stop(child);
        this.readBuffer.clear();
        this.notifyClosed();
      })();
    }
    return this.closing;
  }

  /**
   * The close of a gateway stop: no stdin-EOF grace, SIGTERM to the group at
   * once and SIGKILL `MCP_STDIO_SHUTDOWN_KILL_MS` later, even when an ordinary
   * close is already waiting out its grace. Resolves when the group is gone
   * (or, at worst, about two of those intervals after the call).
   */
  terminate(): Promise<void> {
    this.terminating = true;
    this.wakeTerminate?.();
    return this.close();
  }

  private async stop(child: ChildProcess): Promise<void> {
    const grace = () =>
      this.terminating ? MCP_STDIO_SHUTDOWN_KILL_MS : (this.params.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
    const exited = this.exited ?? Promise.resolve();
    const running = () => child.exitCode === null && child.signalCode === null;
    try {
      child.stdin?.end();
    } catch {
      // no-cause: a stdin that is already closed is the state we want.
    }
    // A terminate() during this wait ends it at once: a stopping gateway gives no stdin grace.
    if (running() && !this.terminating) await waitFor(Promise.race([exited, this.terminateRequested]), grace());
    if (running()) {
      killGroup(child, "SIGTERM");
      // A terminate() during an ordinary grace shortens what is left of it to the shutdown interval.
      const cut = this.terminating ? exited : this.terminateRequested.then(() => delay(MCP_STDIO_SHUTDOWN_KILL_MS));
      await waitFor(Promise.race([exited, cut]), grace());
    }
    // The group goes even when the launcher itself already exited.
    killGroup(child, "SIGKILL");
    if (running()) await waitFor(exited, grace());
    child.stdout?.destroy();
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function waitFor(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // no-cause: the group is already gone; fall back to the child itself.
    try {
      child.kill(signal);
    } catch {
      // no-cause: the child is already gone.
    }
  }
}

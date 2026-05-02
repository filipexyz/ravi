import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../utils/logger.js";

const log = logger.child("codex:transport");

const STDIO_LINE_NEWLINE = "\n";
const WS_LISTENING_REGEX = /listening on:\s+(ws:\/\/[^\s]+)/i;
const WS_READY_TIMEOUT_MS = 10_000;

export type CodexTransportKind = "stdio" | "websocket";

export function resolveCodexTransportKind(env: NodeJS.ProcessEnv = process.env): CodexTransportKind {
  const value = env.RAVI_CODEX_TRANSPORT?.trim().toLowerCase();
  if (value === "stdio") return "stdio";
  return "websocket";
}

export interface CodexTransportSpawnOptions {
  command: string;
  /** Args excluding any transport-specific listen flags (added internally). */
  baseArgs: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Called for each JSON line received from the codex app-server. */
  onMessage: (rawJsonLine: string) => void;
  /**
   * Called when the transport closes unexpectedly (parse error, write error,
   * websocket close, child exit before settled). The provider then settles
   * any active turn with this signal.
   */
  onTransportError: (error: Error) => void;
}

export interface CodexTransport {
  readonly kind: CodexTransportKind;
  /** Spawned child process. Caller owns lifecycle (kill / SIGINT). */
  readonly child: ChildProcess;
  /** Promise that resolves once outbound channel can accept writes. */
  readonly ready: Promise<void>;
  /** Send one JSON-RPC payload (without trailing newline — transport adds if needed). */
  send(payload: string): Promise<void>;
  /** Snapshot of accumulated stderr (kept for crash diagnostics). */
  getStderr(): string;
  /** Position in stderr buffer at this moment (for slicing per-turn). */
  getStderrOffset(): number;
  /** Close the transport channel without killing the child (caller kills explicitly). */
  closeChannel(): void;
}

function attachStderrStreaming(
  spawned: ChildProcess,
  state: { stderr: string; stderrOffset: number },
  onChunk?: (chunk: string) => void,
): void {
  if (!spawned.stderr) return;
  spawned.stderr.setEncoding("utf8");
  spawned.stderr.on("data", (chunk: string) => {
    state.stderr += chunk;
    state.stderrOffset = state.stderr.length;
    // Forward only WARN/ERROR lines from codex to keep the daemon log signal-to-noise
    // high. Full stderr is still buffered in `state.stderr` for crash diagnostics.
    // To diagnose silent hangs, raise verbosity via `RAVI_CODEX_RUST_LOG`.
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!/ (WARN|ERROR) /.test(trimmed)) continue;
      log.warn("codex stderr", { pid: spawned.pid, line: trimmed.slice(0, 4000) });
    }
    onChunk?.(chunk);
  });
}

export function createStdioTransport(opts: CodexTransportSpawnOptions): CodexTransport {
  const spawned = spawn(opts.command, [...opts.baseArgs, "app-server"], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const state = { stderr: "", stderrOffset: 0 };
  attachStderrStreaming(spawned, state);

  if (spawned.stdout) {
    spawned.stdout.setEncoding("utf8");
    const lines = createInterface({ input: spawned.stdout });
    lines.on("line", (line) => {
      const value = line.trim();
      if (!value) return;
      try {
        opts.onMessage(value);
      } catch (error) {
        opts.onTransportError(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  if (spawned.stdin) {
    spawned.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        opts.onTransportError(error);
      }
    });
  }

  const send = async (payload: string): Promise<void> => {
    const stdin = spawned.stdin;
    if (!stdin || spawned.killed) {
      throw new Error("Codex app-server stdin is unavailable");
    }
    const data = payload.endsWith(STDIO_LINE_NEWLINE) ? payload : `${payload}${STDIO_LINE_NEWLINE}`;
    await new Promise<void>((resolve, reject) => {
      stdin.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  return {
    kind: "stdio",
    child: spawned,
    ready: Promise.resolve(),
    send,
    getStderr: () => state.stderr,
    getStderrOffset: () => state.stderrOffset,
    closeChannel: () => {
      try {
        spawned.stdin?.end();
      } catch {
        // already closed
      }
    },
  };
}

export function createWebsocketTransport(opts: CodexTransportSpawnOptions): CodexTransport {
  const spawned = spawn(opts.command, [...opts.baseArgs, "app-server", "--listen", "ws://127.0.0.1:0"], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const state = { stderr: "", stderrOffset: 0 };
  let ws: WebSocket | null = null;
  let resolvedUrl: string | undefined;
  let readySettled = false;
  let transportErrorNotified = false;
  let readyResolve: () => void = () => {};
  let readyReject: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const notifyTransportError = (error: Error) => {
    if (transportErrorNotified) return;
    transportErrorNotified = true;
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      readyReject(error);
    }
    opts.onTransportError(error);
  };

  const readyTimer = setTimeout(() => {
    notifyTransportError(
      new Error(`Codex app-server did not announce a websocket listener within ${WS_READY_TIMEOUT_MS}ms`),
    );
  }, WS_READY_TIMEOUT_MS);

  // Buffer stderr-stream output to discover the listening URL on the very first
  // chunks before delegating to the standard stderr forwarder.
  let initBuffer = "";
  attachStderrStreaming(spawned, state, (chunk) => {
    if (resolvedUrl) return;
    initBuffer += chunk;
    const match = initBuffer.match(WS_LISTENING_REGEX);
    if (!match) return;
    resolvedUrl = match[1];
    connectWebsocket(resolvedUrl);
  });

  const connectWebsocket = (url: string): void => {
    try {
      ws = new WebSocket(url);
    } catch (error) {
      notifyTransportError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    ws.onopen = () => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      readyResolve();
    };
    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      // Codex emits one JSON-RPC message per WebSocket frame. Defensive split
      // on newline keeps us correct if codex ever batches.
      for (const line of data.split("\n")) {
        const value = line.trim();
        if (!value) continue;
        try {
          opts.onMessage(value);
        } catch (error) {
          opts.onTransportError(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    };
    ws.onerror = (event) => {
      const message = (event as ErrorEvent).message ?? "websocket error";
      notifyTransportError(new Error(`codex websocket error: ${message}`));
    };
    ws.onclose = (event: CloseEvent) => {
      if (readySettled && spawned.killed) return;
      // Unclean close while child still alive: surface as transport error so
      // the caller can settle the active turn.
      const error = new Error(`codex websocket closed (code=${event.code}, reason=${event.reason || "n/a"})`);
      notifyTransportError(error);
    };
  };

  spawned.on("error", (error) => {
    clearTimeout(readyTimer);
    notifyTransportError(error);
  });
  spawned.on("close", (exitCode, signal) => {
    clearTimeout(readyTimer);
    if (!readySettled) {
      notifyTransportError(
        new Error(`codex app-server exited before websocket ready (exit=${exitCode}, signal=${signal})`),
      );
    }
  });

  const send = async (payload: string): Promise<void> => {
    if (!ws) throw new Error("Codex websocket is not connected");
    if (ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Codex websocket not OPEN (readyState=${ws.readyState})`);
    }
    // WebSocket messages are framed; no newline appended.
    ws.send(payload);
  };

  return {
    kind: "websocket",
    child: spawned,
    ready,
    send,
    getStderr: () => state.stderr,
    getStderrOffset: () => state.stderrOffset,
    closeChannel: () => {
      clearTimeout(readyTimer);
      try {
        ws?.close();
      } catch {
        // ignore — caller will SIGKILL the child
      }
      ws = null;
    },
  };
}

export function createCodexTransport(kind: CodexTransportKind, opts: CodexTransportSpawnOptions): CodexTransport {
  return kind === "stdio" ? createStdioTransport(opts) : createWebsocketTransport(opts);
}

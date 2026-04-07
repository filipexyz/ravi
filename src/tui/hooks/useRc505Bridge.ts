import { useEffect, useState } from "react";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface Rc505BridgeEvent {
  source: string;
  receivedAt: number;
  kind: string;
  summary: string;
  bytes: number[];
}

export interface Rc505BridgeState {
  connected: boolean;
  message: string | null;
  matchedSources: string[];
  sourceNames: string[];
  lastEvent: Rc505BridgeEvent | null;
  error: string | null;
}

type Rc505BridgeLine =
  | {
      type: "status";
      connected?: boolean;
      message?: string;
      matchedSources?: string[];
      sourceNames?: string[];
    }
  | ({
      type: "event";
    } & Rc505BridgeEvent)
  | {
      type: "error";
      message?: string;
    };

const bridgeScriptPath = fileURLToPath(new URL("../bridges/rc505-bridge.swift", import.meta.url));

export function useRc505Bridge(): Rc505BridgeState {
  const [state, setState] = useState<Rc505BridgeState>({
    connected: false,
    message: "starting bridge",
    matchedSources: [],
    sourceNames: [],
    lastEvent: null,
    error: null,
  });

  useEffect(() => {
    let child: ChildProcessWithoutNullStreams | null = null;
    let buffer = "";

    try {
      child = spawn("swift", [bridgeScriptPath], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
    } catch (error) {
      setState((prev) => ({
        ...prev,
        message: "failed to start bridge",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }

    const handleLine = (line: string) => {
      if (!line.trim()) return;

      let payload: Rc505BridgeLine;
      try {
        payload = JSON.parse(line) as Rc505BridgeLine;
      } catch {
        setState((prev) => ({
          ...prev,
          message: "bridge emitted invalid JSON",
        }));
        return;
      }

      if (payload.type === "status") {
        setState((prev) => ({
          ...prev,
          connected: payload.connected ?? prev.connected,
          message: payload.message ?? prev.message,
          matchedSources: payload.matchedSources ?? prev.matchedSources,
          sourceNames: payload.sourceNames ?? prev.sourceNames,
        }));
        return;
      }

      if (payload.type === "event") {
        setState((prev) => ({
          ...prev,
          connected: true,
          message: `last event from ${payload.source}`,
          lastEvent: payload,
        }));
        return;
      }

      setState((prev) => ({
        ...prev,
        message: payload.message ?? prev.message,
        error: payload.message ?? "bridge error",
      }));
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      setState((prev) => ({
        ...prev,
        message: "bridge stderr",
        error: text,
      }));
    });

    child.on("error", (error) => {
      setState((prev) => ({
        ...prev,
        message: "bridge process error",
        error: error.message,
      }));
    });

    child.on("exit", (code, signal) => {
      setState((prev) => ({
        ...prev,
        connected: false,
        message: `bridge exited${code !== null ? ` (${code})` : signal ? ` (${signal})` : ""}`,
      }));
    });

    return () => {
      child?.kill();
    };
  }, []);

  return state;
}

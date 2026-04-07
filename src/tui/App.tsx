/** @jsxImportSource @opentui/react */

import { useState, useCallback, useEffect, useRef } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { ChatView } from "./components/ChatView.js";
import {
  CockpitView,
  type CockpitActionsSnapshot,
  type CockpitActivitySnapshot,
  type CockpitLanesSnapshot,
  type CockpitStatusSnapshot,
} from "./components/CockpitView.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { InputBar } from "./components/InputBar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { StatusBar } from "./components/StatusBar.js";
import { SLASH_COMMANDS } from "./components/SlashMenu.js";
import { useRc505Bridge } from "./hooks/useRc505Bridge.js";
import { useNats, type TimelineEntry } from "./hooks/useNats.js";
import { resolveRuntimeDisplayLabel } from "./hooks/runtime-display.js";
import { useSessions } from "./hooks/useSessions.js";
import { applyAgentRuntimeSelection } from "./runtime-config.js";
import { dbGetAgent } from "../router/router-db.js";
import { loadConfig } from "../utils/config.js";
import { publish } from "../nats.js";
import { resetSession, resolveSession } from "../router/sessions.js";

const initialSessionName = process.argv[2] || "main";
const tmuxAgentId = process.env.RAVI_TMUX_AGENT || null;
type ActiveView = "chat" | "cockpit";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function RavigatingIndicator() {
  const [frame, setFrame] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER.length);
    }, 80);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  return (
    <box height={1} width="100%" flexDirection="row">
      <text content={` ${SPINNER[frame]} `} fg="cyan" bold />
      <text content="ravigating..." fg="cyan" />
    </box>
  );
}

function summarizeCockpitActivity(entry: TimelineEntry): string {
  if (entry.type === "tool") {
    const status = entry.isError ? "error" : entry.status;
    return truncateCockpitLine(`tool ${entry.toolName} ${status}`);
  }

  const role = entry.role === "user" ? "user" : entry.streaming ? "assistant..." : "assistant";
  return truncateCockpitLine(`${role}: ${entry.content.replace(/\s+/g, " ").trim()}`);
}

function truncateCockpitLine(value: string, max = 56): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function App() {
  const renderer = useRenderer();
  const [sessionName, setSessionName] = useState(initialSessionName);
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const lastRcEventAtRef = useRef<number | null>(null);
  const { sessions, refresh: refreshSessions } = useSessions({ agentId: tmuxAgentId });
  const rc505 = useRc505Bridge();

  // Auto-copy selected text to clipboard via OSC 52
  useEffect(() => {
    const onSelection = () => {
      const sel = renderer.getSelection();
      if (!sel) return;
      const text = sel.getSelectedText();
      if (text) {
        renderer.copyToClipboardOSC52(text);
      }
    };
    renderer.on("selection", onSelection);
    return () => {
      renderer.off("selection", onSelection);
    };
  }, [renderer]);

  const {
    messages,
    sendMessage,
    clearMessages,
    pushMessage,
    isConnected,
    isTyping,
    isCompacting,
    isWorking,
    stopWorking,
    totalTokens,
    runtimeInfo,
  } = useNats(sessionName);

  // Resolve current session/agent metadata directly from SQLite so the status
  // bar reflects live provider changes without waiting for the palette list.
  const currentSession = resolveSession(sessionName);
  const agentId = currentSession?.agentId ?? tmuxAgentId ?? "unknown";
  const agent = agentId === "unknown" ? null : dbGetAgent(agentId);
  const runtimeLabel = resolveRuntimeDisplayLabel({
    configuredProvider: agent?.provider ?? "claude",
    runtimeProvider: runtimeInfo.provider ?? currentSession?.runtimeProvider ?? null,
    configuredModel: currentSession?.modelOverride ?? agent?.model ?? loadConfig().model,
    executionModel: runtimeInfo.executionModel,
  });
  const channelParts = [
    currentSession?.lastChannel ?? currentSession?.channel,
    currentSession?.chatType,
    currentSession?.accountId,
  ].filter(Boolean);
  const alerts: string[] = [];
  if (!isConnected) {
    alerts.push("session bus disconnected");
  }
  if (currentSession?.abortedLastRun) {
    alerts.push("last run aborted");
  }
  const cockpitStatus: CockpitStatusSnapshot = {
    daemon: isConnected ? "reachable via NATS" : "unreachable",
    runtime: `${runtimeLabel.provider}/${runtimeLabel.model}`,
    channel: channelParts.length > 0 ? channelParts.join(" / ") : undefined,
    activity: isCompacting ? "compacting" : isWorking ? "working" : isTyping ? "typing" : "idle",
    alerts,
    session: `${sessionName} (${agentId})`,
  };
  const recentThresholdMs = 15 * 60 * 1000;
  const now = Date.now();
  const cockpitLanes: CockpitLanesSnapshot = {
    totalSessions: sessions.length,
    recentSessions: sessions.filter((session) => now - session.updatedAt <= recentThresholdMs).length,
    queuedSessions: sessions.filter((session) => Boolean(session.queueMode)).length,
    blockedSessions: sessions.filter((session) => session.abortedLastRun).length,
    ephemeralSessions: sessions.filter((session) => session.ephemeral).length,
    focusSession: sessionName,
  };
  const cockpitActions: CockpitActionsSnapshot = {
    items: [
      { id: "switch", label: "Switch", trigger: "Ctrl+K or /switch", enabled: true },
      { id: "reset", label: "Reset", trigger: "/reset", enabled: Boolean(currentSession?.sessionKey) },
      { id: "model", label: "Model", trigger: "/model", enabled: Boolean(currentSession && agent) },
    ],
  };
  const activityFeed = messages.slice(-3).map(summarizeCockpitActivity);
  if (rc505.lastEvent) {
    activityFeed.push(truncateCockpitLine(`rc505 ${rc505.lastEvent.kind}: ${rc505.lastEvent.summary}`));
  } else if (rc505.message) {
    activityFeed.push(truncateCockpitLine(`rc505 bridge: ${rc505.message}`));
  }
  const cockpitActivity: CockpitActivitySnapshot = {
    feed: activityFeed.slice(-4),
  };

  useEffect(() => {
    if (activeView === "cockpit") {
      refreshSessions();
    }
  }, [activeView, refreshSessions]);

  useEffect(() => {
    const lastEventAt = rc505.lastEvent?.receivedAt;
    if (!lastEventAt || lastRcEventAtRef.current === lastEventAt) {
      return;
    }
    lastRcEventAtRef.current = lastEventAt;
    setActiveView("cockpit");
  }, [rc505.lastEvent?.receivedAt]);

  // Toggle command palette with Ctrl+K
  useKeyboard((key) => {
    if (modelPickerOpen) return;
    if (key.ctrl && key.name === "k") {
      setPaletteOpen((prev) => {
        if (!prev) {
          refreshSessions();
        }
        return !prev;
      });
      return;
    }
    if (key.ctrl && key.name === "o") {
      setActiveView((prev) => (prev === "chat" ? "cockpit" : "chat"));
    }
  });

  const handleSelectSession = useCallback((name: string) => {
    setSessionName(name);
    setPaletteOpen(false);
  }, []);

  const handleClosePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  const handleAbort = useCallback(() => {
    if (!isWorking) return;
    const sk = currentSession?.sessionKey;
    if (sk) {
      publish("ravi.session.abort", { sessionKey: sk, sessionName }).catch(() => {});
    }
    stopWorking();
    pushMessage({
      id: `system-${Date.now()}`,
      type: "chat",
      role: "assistant",
      content: "Aborted.",
      timestamp: Date.now(),
    });
  }, [currentSession, sessionName, isWorking, stopWorking, pushMessage]);

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
      if (activeView === "cockpit") {
        setActiveView("chat");
      }
    },
    [sendMessage, activeView],
  );

  const handleSlashCommand = useCallback(
    (cmd: string) => {
      switch (cmd) {
        case "switch":
          refreshSessions();
          setPaletteOpen(true);
          break;
        case "reset": {
          const sk = currentSession?.sessionKey;
          if (sk) {
            publish("ravi.session.abort", { sessionKey: sk, sessionName }).catch(() => {});
            resetSession(sk);
          }
          clearMessages();
          pushMessage({
            id: `system-${Date.now()}`,
            type: "chat",
            role: "assistant",
            content: "Session reset.",
            timestamp: Date.now(),
          });
          break;
        }
        case "help": {
          const lines = SLASH_COMMANDS.map((c) => `  /${c.name}  — ${c.description}`).join("\n");
          pushMessage({
            id: `system-${Date.now()}`,
            type: "chat",
            role: "assistant",
            content: `Available commands:\n${lines}`,
            timestamp: Date.now(),
          });
          break;
        }
        case "model":
          setModelPickerOpen(true);
          break;
        case "cockpit":
          setActiveView("cockpit");
          break;
        case "chat":
          setActiveView("chat");
          break;
      }
    },
    [refreshSessions, clearMessages, pushMessage, currentSession, sessionName],
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      {activeView === "cockpit" ? (
        <CockpitView status={cockpitStatus} lanes={cockpitLanes} actions={cockpitActions} activity={cockpitActivity} />
      ) : (
        <ChatView messages={messages} />
      )}

      {/* Typing / compacting indicator */}
      {isCompacting ? (
        <box height={1} width="100%">
          <text content=" ⟳ compacting context..." fg="yellow" />
        </box>
      ) : isWorking ? (
        <RavigatingIndicator />
      ) : null}

      {/* Input bar */}
      <InputBar
        onSend={handleSend}
        onSlashCommand={handleSlashCommand}
        onAbort={handleAbort}
        placeholder={
          activeView === "cockpit"
            ? "Cockpit mode. Use /chat or Ctrl+O to return."
            : "Type a message... (\\ for newline)"
        }
        isWorking={isWorking}
        active={!paletteOpen && !modelPickerOpen}
        extraOffset={isCompacting || isWorking ? 1 : 0}
      />

      {/* Status bar (footer) */}
      <StatusBar
        sessionName={sessionName}
        agentId={agentId}
        isConnected={isConnected}
        runtimeLabel={runtimeLabel}
        isTyping={isTyping}
        isCompacting={isCompacting}
        totalTokens={totalTokens}
      />

      {/* Session picker overlay */}
      {paletteOpen && (
        <>
          <box
            position="absolute"
            top={0}
            left={0}
            width="100%"
            height="100%"
            backgroundColor="black"
            shouldFill
            opacity={0.5}
            zIndex={99}
          />
          <CommandPalette
            sessions={sessions}
            currentSessionName={sessionName}
            onSelect={handleSelectSession}
            onClose={handleClosePalette}
          />
        </>
      )}

      {modelPickerOpen && currentSession && agent && (
        <>
          <box
            position="absolute"
            top={0}
            left={0}
            width="100%"
            height="100%"
            backgroundColor="black"
            shouldFill
            opacity={0.5}
            zIndex={99}
          />
          <ModelPicker
            agentId={agent.id}
            currentProvider={agent.provider ?? "claude"}
            currentModel={currentSession.modelOverride ?? agent.model ?? null}
            onClose={() => setModelPickerOpen(false)}
            onApply={({ provider, model }) => {
              void (async () => {
                try {
                  await applyAgentRuntimeSelection({
                    agentId: agent.id,
                    sessionKey: currentSession.sessionKey,
                    provider,
                    model,
                  });
                  refreshSessions();
                  setModelPickerOpen(false);
                  pushMessage({
                    id: `system-${Date.now()}`,
                    type: "chat",
                    role: "assistant",
                    content: `Agent ${agent.id} now uses ${provider}/${model}. Next turn will use the new runtime settings.`,
                    timestamp: Date.now(),
                  });
                } catch (error) {
                  setModelPickerOpen(false);
                  pushMessage({
                    id: `system-${Date.now()}`,
                    type: "chat",
                    role: "assistant",
                    content: `Failed to update runtime: ${error instanceof Error ? error.message : String(error)}`,
                    timestamp: Date.now(),
                  });
                }
              })();
            }}
          />
        </>
      )}
    </box>
  );
}

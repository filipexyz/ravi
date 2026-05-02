/** @jsxImportSource @opentui/react */

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { ChatView } from "./components/ChatView.js";
import {
  CockpitView,
  type CockpitActionsSnapshot,
  type CockpitActivitySnapshot,
  type CockpitStatusSnapshot,
} from "./components/CockpitView.js";
import { InputBar } from "./components/InputBar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { StatusBar } from "./components/StatusBar.js";
import { SLASH_COMMANDS } from "./components/SlashMenu.js";
import { useRc505Bridge } from "./hooks/useRc505Bridge.js";
import { useNats, type TimelineEntry } from "./hooks/useNats.js";
import { useSessionMetadata } from "./hooks/useSessionMetadata.js";
import { resolveRuntimeDisplayLabel } from "./hooks/runtime-display.js";
import { applyAgentRuntimeSelection } from "./runtime-config.js";
import { publish } from "../nats.js";
import { resetSession } from "../router/sessions.js";

const sessionName = process.argv[2] || "main";
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
  const [activeView, setActiveView] = useState<ActiveView>("chat");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const lastRcEventAtRef = useRef<number | null>(null);
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

  // Cached session/agent/config metadata. Refreshed on `ravi.config.changed`
  // — see `useSessionMetadata`. Previously these were synchronous SQLite
  // queries on every render and dominated CPU during streaming.
  const { session: currentSession, agent, defaultModel } = useSessionMetadata(sessionName);
  const agentId = currentSession?.agentId ?? "unknown";

  const runtimeLabel = useMemo(
    () =>
      resolveRuntimeDisplayLabel({
        configuredProvider: agent?.provider ?? "claude",
        runtimeProvider: runtimeInfo.provider ?? currentSession?.runtimeProvider ?? null,
        configuredModel: currentSession?.modelOverride ?? agent?.model ?? defaultModel,
        executionModel: runtimeInfo.executionModel,
      }),
    [
      agent?.provider,
      agent?.model,
      runtimeInfo.provider,
      runtimeInfo.executionModel,
      currentSession?.runtimeProvider,
      currentSession?.modelOverride,
      defaultModel,
    ],
  );

  const channelParts = useMemo(
    () =>
      [
        currentSession?.lastChannel ?? currentSession?.channel,
        currentSession?.chatType,
        currentSession?.accountId,
      ].filter(Boolean) as string[],
    [currentSession?.lastChannel, currentSession?.channel, currentSession?.chatType, currentSession?.accountId],
  );

  const alerts = useMemo(() => {
    const out: string[] = [];
    if (!isConnected) out.push("session bus disconnected");
    if (currentSession?.abortedLastRun) out.push("last run aborted");
    return out;
  }, [isConnected, currentSession?.abortedLastRun]);

  const cockpitStatus = useMemo<CockpitStatusSnapshot>(
    () => ({
      daemon: isConnected ? "reachable via NATS" : "unreachable",
      runtime: `${runtimeLabel.provider}/${runtimeLabel.model}`,
      channel: channelParts.length > 0 ? channelParts.join(" / ") : undefined,
      activity: isCompacting ? "compacting" : isWorking ? "working" : isTyping ? "typing" : "idle",
      alerts,
      session: `${sessionName} (${agentId})`,
    }),
    [isConnected, runtimeLabel, channelParts, isCompacting, isWorking, isTyping, alerts, agentId],
  );

  const cockpitActions = useMemo<CockpitActionsSnapshot>(
    () => ({
      items: [
        { id: "reset", label: "Reset", trigger: "/reset", enabled: Boolean(currentSession?.sessionKey) },
        { id: "model", label: "Model", trigger: "/model", enabled: Boolean(currentSession && agent) },
      ],
    }),
    [currentSession?.sessionKey, currentSession, agent],
  );

  const cockpitActivity = useMemo<CockpitActivitySnapshot>(() => {
    const feed = messages.slice(-3).map(summarizeCockpitActivity);
    if (rc505.lastEvent) {
      feed.push(truncateCockpitLine(`rc505 ${rc505.lastEvent.kind}: ${rc505.lastEvent.summary}`));
    } else if (rc505.message) {
      feed.push(truncateCockpitLine(`rc505 bridge: ${rc505.message}`));
    }
    return { feed: feed.slice(-4) };
  }, [messages, rc505.lastEvent, rc505.message]);

  useEffect(() => {
    const lastEventAt = rc505.lastEvent?.receivedAt;
    if (!lastEventAt || lastRcEventAtRef.current === lastEventAt) {
      return;
    }
    lastRcEventAtRef.current = lastEventAt;
    setActiveView("cockpit");
  }, [rc505.lastEvent?.receivedAt]);

  useKeyboard((key) => {
    if (modelPickerOpen) return;
    if (key.ctrl && key.name === "o") {
      setActiveView((prev) => (prev === "chat" ? "cockpit" : "chat"));
    }
  });

  const handleAbort = useCallback(() => {
    if (!isWorking) return;
    const sk = currentSession?.sessionKey;
    if (sk) {
      publish("ravi.session.abort", {
        sessionKey: sk,
        sessionName,
        source: "tui",
        action: "abort",
        reason: "tui_abort",
        actor: "operator",
      }).catch(() => {});
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
        case "reset": {
          const sk = currentSession?.sessionKey;
          if (sk) {
            publish("ravi.session.abort", {
              sessionKey: sk,
              sessionName,
              source: "tui",
              action: "reset",
              reason: "tui_reset",
              actor: "operator",
            }).catch(() => {});
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
    [clearMessages, pushMessage, currentSession, sessionName],
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      {activeView === "cockpit" ? (
        <CockpitView status={cockpitStatus} actions={cockpitActions} activity={cockpitActivity} />
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
        active={!modelPickerOpen}
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

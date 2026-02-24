/** @jsxImportSource @opentui/react */

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { ChatView } from "./components/ChatView.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { InputBar } from "./components/InputBar.js";
import { StatusBar } from "./components/StatusBar.js";
import { SLASH_COMMANDS } from "./components/SlashMenu.js";
import { useNats } from "./hooks/useNats.js";
import { useSessions } from "./hooks/useSessions.js";
import { dbGetAgent } from "../router/router-db.js";
import { loadConfig } from "../utils/config.js";

const initialSessionName = process.argv[2] || "main";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function RavigatingIndicator() {
  const [frame, setFrame] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    timerRef.current = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER.length);
    }, 80);
    return () => clearInterval(timerRef.current);
  }, []);

  return (
    <box height={1} width="100%" flexDirection="row">
      <text content={` ${SPINNER[frame]} `} fg="cyan" bold />
      <text content="ravigating..." fg="cyan" />
    </box>
  );
}

export function App() {
  const [sessionName, setSessionName] = useState(initialSessionName);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { sessions, refresh: refreshSessions } = useSessions();

  const {
    messages,
    sendMessage,
    clearMessages,
    pushMessage,
    isConnected,
    isTyping,
    isCompacting,
    isWorking,
    totalTokens,
  } = useNats(sessionName);

  // Resolve agent info from session list
  const currentSession = useMemo(
    () => sessions.find((s) => s.name === sessionName),
    [sessions, sessionName],
  );
  const agentId = currentSession?.agentId ?? "unknown";
  const model = useMemo(() => {
    if (agentId === "unknown") return loadConfig().model;
    const agent = dbGetAgent(agentId);
    return agent?.model ?? loadConfig().model;
  }, [agentId]);

  // Toggle command palette with Ctrl+K
  useKeyboard(
    (key) => {
      if (key.ctrl && key.name === "k") {
        setPaletteOpen((prev) => {
          if (!prev) {
            refreshSessions();
          }
          return !prev;
        });
      }
    },
  );

  const handleSelectSession = useCallback((name: string) => {
    setSessionName(name);
    setPaletteOpen(false);
  }, []);

  const handleClosePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);

  const handleSlashCommand = useCallback(
    (cmd: string) => {
      switch (cmd) {
        case "switch":
          refreshSessions();
          setPaletteOpen(true);
          break;
        case "clear":
          clearMessages();
          break;
        case "help": {
          const lines = SLASH_COMMANDS.map(
            (c) => `  /${c.name}  — ${c.description}`,
          ).join("\n");
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
          pushMessage({
            id: `system-${Date.now()}`,
            type: "chat",
            role: "assistant",
            content: "Model picker coming soon.",
            timestamp: Date.now(),
          });
          break;
      }
    },
    [refreshSessions, clearMessages, pushMessage],
  );

  return (
    <box flexDirection="column" width="100%" height="100%">
      {/* Chat area */}
      <ChatView messages={messages} />

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
        onSend={sendMessage}
        onSlashCommand={handleSlashCommand}
        active={!paletteOpen}
      />

      {/* Status bar (footer) */}
      <StatusBar
        sessionName={sessionName}
        agentId={agentId}
        isConnected={isConnected}
        model={model}
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
    </box>
  );
}

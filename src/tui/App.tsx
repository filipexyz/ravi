/** @jsxImportSource @opentui/react */

import { useState, useCallback, useMemo } from "react";
import { useKeyboard } from "@opentui/react";
import { ChatView } from "./components/ChatView.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { InputBar } from "./components/InputBar.js";
import { StatusBar } from "./components/StatusBar.js";
import { SLASH_COMMANDS } from "./components/SlashMenu.js";
import { useNats } from "./hooks/useNats.js";
import { useSessions } from "./hooks/useSessions.js";
import { dbGetAgent } from "../router/router-db.js";

const initialSessionName = process.argv[2] || "main";

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
  } = useNats(sessionName);

  // Resolve agent info from session list
  const currentSession = useMemo(
    () => sessions.find((s) => s.name === sessionName),
    [sessions, sessionName],
  );
  const agentId = currentSession?.agentId ?? "unknown";
  const model = useMemo(() => {
    if (agentId === "unknown") return null;
    const agent = dbGetAgent(agentId);
    return agent?.model ?? null;
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
      <ChatView
        messages={messages}
        isTyping={isTyping}
        isCompacting={isCompacting}
      />

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
      />

      {/* Command palette overlay */}
      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          currentSessionName={sessionName}
          onSelect={handleSelectSession}
          onClose={handleClosePalette}
        />
      )}
    </box>
  );
}

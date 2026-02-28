/** @jsxImportSource @opentui/react */

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { SessionItem } from "../hooks/useSessions.js";

export interface CommandPaletteProps {
  sessions: SessionItem[];
  currentSessionName: string;
  onSelect: (sessionName: string) => void;
  onClose: () => void;
}

/**
 * Session picker overlay, centered on screen.
 */
export function CommandPalette({ sessions, currentSessionName, onSelect, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const renderer = useRenderer();

  const filtered = useMemo(() => {
    if (!query) return sessions;
    const lower = query.toLowerCase();
    return sessions.filter(
      (s) =>
        s.name.toLowerCase().includes(lower) ||
        s.agentId.toLowerCase().includes(lower) ||
        (s.model?.toLowerCase().includes(lower) ?? false),
    );
  }, [sessions, query]);

  const clampedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || filtered.length === 0) return;
    sb.scrollTo(clampedIndex);
  }, [clampedIndex, filtered.length]);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    setSelectedIndex(0);
  }, []);

  useKeyboard((key) => {
    if (key.name === "escape") {
      onClose();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (filtered.length > 0) {
        const session = filtered[clampedIndex];
        if (session) {
          onSelect(session.name);
        }
      }
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
      return;
    }
  });

  const maxVisible = Math.min(filtered.length, 15, Math.max(1, Math.floor(renderer.height / 2) - 9));
  const overlayHeight = maxVisible + 9;
  const overlayWidth = Math.floor(renderer.width * 0.6);

  return (
    <box
      position="absolute"
      top={Math.max(0, Math.floor((renderer.height - overlayHeight) / 2))}
      left={Math.max(0, Math.floor((renderer.width - overlayWidth) / 2))}
      width={overlayWidth}
      height={overlayHeight}
      flexDirection="column"
      border
      borderColor="cyan"
      backgroundColor="black"
      shouldFill
      padding={1}
      zIndex={100}
    >
      <text content="Switch Session (Ctrl+K)" fg="cyan" bg="black" bold />

      <box height={3} width="100%" border borderColor="gray" backgroundColor="black">
        <input
          ref={inputRef}
          focused
          flexGrow={1}
          placeholder="Search sessions..."
          onInput={handleInput}
          fg="white"
          backgroundColor="black"
        />
      </box>

      <scrollbox ref={scrollRef} flexGrow={1} width="100%" scrollY backgroundColor="black">
        <box flexDirection="column" width="100%" backgroundColor="black">
          {filtered.length === 0 ? (
            <text content="  No sessions found" fg="gray" bg="black" />
          ) : (
            filtered.map((session, index) => {
              const isSelected = index === clampedIndex;
              const isCurrent = session.name === currentSessionName;
              const prefix = isSelected ? "> " : "  ";
              const suffix = isCurrent ? " *" : "";
              const nameFg = isSelected ? "cyan" : isCurrent ? "green" : "white";

              return (
                <box key={session.sessionKey} flexDirection="row" width="100%" backgroundColor="black">
                  <text content={`${prefix}${session.name}`} fg={nameFg} bg="black" bold={isSelected} />
                  <text content={` (${session.agentId})`} fg="gray" bg="black" />
                  {suffix ? <text content={suffix} fg={nameFg} bg="black" /> : null}
                </box>
              );
            })
          )}
        </box>
      </scrollbox>

      <box height={1} width="100%" backgroundColor="black">
        <text content="  arrows: navigate | enter: select | esc: close" fg="gray" bg="black" />
      </box>
    </box>
  );
}

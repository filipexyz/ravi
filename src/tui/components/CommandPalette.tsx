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
 * Command palette overlay for session switching.
 *
 * - Centered on screen (vertical + horizontal)
 * - Single-line entries: name (model) or name
 * - Auto-scrolls to keep selected item visible
 * - Arrow up/down, Enter, Escape
 */
export function CommandPalette({
  sessions,
  currentSessionName,
  onSelect,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<InputRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const renderer = useRenderer();

  // Filter sessions by substring match on name, agentId, or model
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

  // Clamp selectedIndex when filtered list changes
  const clampedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  // Auto-scroll to keep selected item visible
  useEffect(() => {
    const sb = scrollRef.current;
    if (!sb || filtered.length === 0) return;
    sb.scrollTo(clampedIndex);
  }, [clampedIndex, filtered.length]);

  const handleInput = useCallback(
    (value: string) => {
      setQuery(value);
      setSelectedIndex(0);
    },
    [],
  );

  useKeyboard(
    (key) => {
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
    },
  );

  // Layout: title(1) + search(3) + help(1) = 5 fixed rows + border(2) + padding(2) = 9 chrome
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
      bg="black"
      padding={1}
    >
      {/* Title */}
      <text content="Switch Session (Ctrl+K)" fg="cyan" bold />

      {/* Search input */}
      <box height={3} width="100%" border borderColor="gray">
        <input
          ref={inputRef}
          focused
          flexGrow={1}
          placeholder="Search sessions..."
          onInput={handleInput}
          fg="white"
        />
      </box>

      {/* Session list — single line per entry */}
      <scrollbox ref={scrollRef} flexGrow={1} width="100%" scrollY>
        <box flexDirection="column" width="100%">
          {filtered.length === 0 ? (
            <text content="  No sessions found" fg="gray" />
          ) : (
            filtered.map((session, index) => {
              const isSelected = index === clampedIndex;
              const isCurrent = session.name === currentSessionName;
              const prefix = isSelected ? "> " : "  ";
              const suffix = isCurrent ? " *" : "";
              const nameFg = isSelected ? "cyan" : isCurrent ? "green" : "white";

              return (
                <box key={session.sessionKey} flexDirection="row" width="100%">
                  <text
                    content={`${prefix}${session.name}`}
                    fg={nameFg}
                    bold={isSelected}
                  />
                  <text
                    content={` (${session.agentId})`}
                    fg="gray"
                  />
                  {suffix ? <text content={suffix} fg={nameFg} /> : null}
                </box>
              );
            })
          )}
        </box>
      </scrollbox>

      {/* Help line — fixed height so it doesn't eat into scrollbox */}
      <box height={1} width="100%">
        <text
          content="  arrows: navigate | enter: select | esc: close"
          fg="gray"
        />
      </box>
    </box>
  );
}

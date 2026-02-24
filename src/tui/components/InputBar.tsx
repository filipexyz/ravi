/** @jsxImportSource @opentui/react */

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { useKeyboard } from "@opentui/react";
import type { InputRenderable } from "@opentui/core";
import { SlashMenu, filterCommands } from "./SlashMenu.js";

interface InputBarProps {
  onSend: (text: string) => void;
  onSlashCommand: (cmd: string) => void;
  /** When true, aggressively keeps focus on the input */
  active?: boolean;
}

/**
 * Input bar for typing and sending messages.
 * Enter submits the message, input clears after submit.
 * Typing `/` opens a slash command dropdown.
 */
export function InputBar({
  onSend,
  onSlashCommand,
  active = true,
}: InputBarProps) {
  const inputRef = useRef<InputRenderable>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = useMemo(() => filterCommands(slashQuery), [slashQuery]);

  // Aggressively keep focus on input when active
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, 100);
    return () => clearInterval(id);
  }, [active]);

  // Track input value for slash detection
  const handleInput = useCallback((value: string) => {
    if (value.startsWith("/")) {
      setSlashOpen(true);
      setSlashQuery(value.slice(1));
      setSelectedIndex(0);
    } else {
      setSlashOpen(false);
    }
  }, []);

  // Navigate slash menu with arrows / close with Escape
  useKeyboard(
    (key) => {
      if (!slashOpen) return;
      if (key.name === "escape") {
        setSlashOpen(false);
        if (inputRef.current) inputRef.current.value = "";
      }
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
      }
    },
  );

  const handleSubmit = useCallback(
    (value: string) => {
      // Slash command selection
      if (slashOpen && filtered.length > 0) {
        const clamped = Math.min(selectedIndex, filtered.length - 1);
        const cmd = filtered[clamped];
        if (cmd) {
          onSlashCommand(cmd.name);
        }
        setSlashOpen(false);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }

      // Normal message send
      const text = value.trim();
      if (!text) return;
      onSend(text);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
    [slashOpen, filtered, selectedIndex, onSlashCommand, onSend],
  );

  return (
    <box
      height={3}
      width="100%"
      border={["top", "bottom"]}
      borderColor="gray"
      borderFocusedColor="cyan"
    >
      {slashOpen && (
        <SlashMenu query={slashQuery} selectedIndex={selectedIndex} />
      )}
      <input
        ref={inputRef}
        focused
        flexGrow={1}
        placeholder="Type a message... (/ for commands)"
        onInput={handleInput}
        onSubmit={handleSubmit}
        fg="white"
      />
    </box>
  );
}

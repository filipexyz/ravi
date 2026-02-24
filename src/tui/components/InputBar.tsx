/** @jsxImportSource @opentui/react */

import { useRef, useCallback, useEffect, useState, useMemo } from "react";
import { useKeyboard } from "@opentui/react";
import type { TextareaRenderable } from "@opentui/core";
import { SlashMenu, filterCommands } from "./SlashMenu.js";

interface InputBarProps {
  onSend: (text: string) => void;
  onSlashCommand: (cmd: string) => void;
  /** When true, aggressively keeps focus on the input */
  active?: boolean;
}

const textareaKeyBindings = [
  // Enter = submit (override default newline)
  { name: "return", action: "submit" as const },
  // Shift+Enter = newline (Kitty-capable terminals: iTerm2, WezTerm, Ghostty, Kitty)
  { name: "return", shift: true, action: "newline" as const },
  // Option/Alt+Enter = newline (works when "Option as Meta/Esc+" is enabled)
  { name: "return", meta: true, action: "newline" as const },
  // linefeed (0x0A) = newline (some terminals send this for Shift+Enter)
  { name: "linefeed", action: "newline" as const },
];

/**
 * Input bar for typing and sending messages.
 * Enter submits. Newline via: Shift+Enter, Option+Enter, or `\`.
 * Typing `/` opens a slash command dropdown.
 */
export function InputBar({
  onSend,
  onSlashCommand,
  active = true,
}: InputBarProps) {
  const textareaRef = useRef<TextareaRenderable>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [lineCount, setLineCount] = useState(1);

  const filtered = useMemo(() => filterCommands(slashQuery), [slashQuery]);

  // Aggressively keep focus on textarea when active
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      textareaRef.current?.focus();
    }, 100);
    return () => clearInterval(id);
  }, [active]);

  // Intercept `\` key to insert newline + sync lineCount after every keypress
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const origHandleKeyPress = ta.handleKeyPress.bind(ta);
    ta.handleKeyPress = (key: any) => {
      if (key.sequence === "\\") {
        ta.newLine();
        setLineCount(ta.lineCount);
        return true;
      }
      const result = origHandleKeyPress(key);
      setLineCount(ta.lineCount);
      return result;
    };
  }, []);

  // Wire up submit handler
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.onSubmit = () => {
      const text = ta.plainText;

      // Slash command selection
      if (slashOpen && filtered.length > 0) {
        const clamped = Math.min(selectedIndex, filtered.length - 1);
        const cmd = filtered[clamped];
        if (cmd) {
          onSlashCommand(cmd.name);
        }
        setSlashOpen(false);
        ta.clear();
        setLineCount(1);
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) return;
      onSend(trimmed);
      ta.clear();
      setLineCount(1);
    };
  });

  // Track input for slash detection + line count
  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const text = ta.plainText;
    setLineCount(ta.lineCount);

    if (text.startsWith("/") && !text.includes("\n")) {
      setSlashOpen(true);
      setSlashQuery(text.slice(1));
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
        const ta = textareaRef.current;
        if (ta) {
          ta.clear();
          setLineCount(1);
        }
      }
      if (key.name === "up" || (key.ctrl && key.name === "p")) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      }
      if (key.name === "down" || (key.ctrl && key.name === "n")) {
        setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
      }
    },
  );

  // Dynamic height: border(2) + visible lines, capped at 8 lines
  const visibleLines = Math.min(lineCount, 8);
  const barHeight = visibleLines + 2;

  return (
    <box
      height={barHeight}
      width="100%"
      border={["top", "bottom"]}
      borderColor="gray"
      borderFocusedColor="cyan"
    >
      {slashOpen && (
        <SlashMenu query={slashQuery} selectedIndex={selectedIndex} />
      )}
      <textarea
        ref={textareaRef}
        focused
        flexGrow={1}
        placeholder="Type a message... (\ for newline)"
        keyBindings={textareaKeyBindings}
        onInput={handleInput}
        textColor="white"
      />
    </box>
  );
}

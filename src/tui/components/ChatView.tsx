/** @jsxImportSource @opentui/react */

import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { MessageBubble } from "./MessageBubble.js";
import { ToolBlock } from "./ToolBlock.js";
import type { TimelineEntry } from "../hooks/useNats.js";

interface ChatViewProps {
  messages: TimelineEntry[];
  isTyping: boolean;
  isCompacting: boolean;
}

/**
 * Scrollable chat view containing message list, tool blocks, and status indicators.
 * Uses stickyScroll to auto-scroll to bottom on new messages.
 * Scrolling up pauses follow mode; new content restores it.
 */
export function ChatView({ messages, isTyping, isCompacting }: ChatViewProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Auto-scroll to bottom when new messages arrive or status changes
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) {
      scrollBox.stickyScroll = true;
    }
  }, [messages.length, isTyping, isCompacting]);

  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      width="100%"
      stickyScroll
      stickyStart="bottom"
      scrollY
    >
      <box flexDirection="column" width="100%" padding={1}>
        {/* ASCII logo */}
        <box flexDirection="column" width="100%" marginBottom={3}>
          <text content={[
            "                 _ ",
            " _ __ __ ___   _(_)",
            "| '__/ _` \\ \\ / / |",
            "| | | (_| |\\ V /| |",
            "|_|  \\__,_| \\_/ |_|",
          ].join("\n")} fg="cyan" />
        </box>

        {messages.length === 0 && !isTyping && !isCompacting ? (
          <text content="No messages yet" fg="gray" />
        ) : (
          messages.map((entry) => {
            if (entry.type === "tool") {
              return <ToolBlock key={entry.id} tool={entry} />;
            }
            return <MessageBubble key={entry.id} message={entry} />;
          })
        )}

        {/* Compacting indicator */}
        {isCompacting ? (
          <box width="100%" marginTop={1}>
            <text content={"\u27F3 compacting context..."} fg="yellow" />
          </box>
        ) : null}

        {/* Typing indicator */}
        {isTyping && !isCompacting ? (
          <box width="100%" marginTop={1}>
            <text content={"\u22EF typing..."} fg="cyan" />
          </box>
        ) : null}
      </box>
    </scrollbox>
  );
}

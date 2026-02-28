/** @jsxImportSource @opentui/react */

import { useEffect, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { MessageBubble } from "./MessageBubble.js";
import { ToolBlock } from "./ToolBlock.js";
import type { TimelineEntry } from "../hooks/useNats.js";

interface ChatViewProps {
  messages: TimelineEntry[];
}

/**
 * Scrollable chat view containing message list and tool blocks.
 * Uses stickyScroll to auto-scroll to bottom on new messages.
 */
export function ChatView({ messages }: ChatViewProps) {
  const scrollRef = useRef<ScrollBoxRenderable>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const scrollBox = scrollRef.current;
    if (scrollBox) {
      scrollBox.stickyScroll = true;
    }
  }, [messages.length]);

  return (
    <scrollbox ref={scrollRef} flexGrow={1} width="100%" stickyScroll stickyStart="bottom" scrollY>
      <box flexDirection="column" width="100%" padding={1}>
        {/* ASCII logo */}
        <box flexDirection="column" width="100%" marginBottom={3}>
          <text
            content={[
              "                 _ ",
              " _ __ __ ___   _(_)",
              "| '__/ _` \\ \\ / / |",
              "| | | (_| |\\ V /| |",
              "|_|  \\__,_| \\_/ |_|",
            ].join("\n")}
            fg="cyan"
          />
        </box>

        {messages.length === 0 ? (
          <text content="No messages yet" fg="gray" />
        ) : (
          messages.map((entry, i) => {
            const prev = i > 0 ? messages[i - 1] : null;
            const needsSpacer = prev?.type === "tool" && entry.type === "chat";
            if (entry.type === "tool") {
              return <ToolBlock key={entry.id} tool={entry} />;
            }
            return (
              <>
                {needsSpacer && <box key={`spacer-${entry.id}`} height={1} width="100%" />}
                <MessageBubble key={entry.id} message={entry} />
              </>
            );
          })
        )}
      </box>
    </scrollbox>
  );
}

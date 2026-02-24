/** @jsxImportSource @opentui/react */

import type { ChatMessage } from "../hooks/useNats.js";

interface MessageBubbleProps {
  message: ChatMessage;
}

/**
 * Renders a single chat message.
 *
 * - User messages: green ">" prefix, plain text
 * - Assistant messages: rendered with <markdown> for rich formatting
 */
export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <box width="100%" marginBottom={1}>
        <text content={` ❯ ${message.content} `} fg="white" bg="#333333" />
      </box>
    );
  }

  return (
    <box width="100%" marginBottom={1} flexDirection="row">
      <text content="⏺ " fg="green" />
      <box flexDirection="column" flexGrow={1}>
        {message.streaming ? (
          <text content={message.content} fg="white" />
        ) : (
          <markdown content={message.content} conceal />
        )}
      </box>
    </box>
  );
}

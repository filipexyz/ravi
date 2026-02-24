/** @jsxImportSource @opentui/react */

export interface StatusBarProps {
  sessionName: string;
  agentId: string;
  isConnected: boolean;
  model: string | null;
  isTyping: boolean;
  isCompacting: boolean;
}

/**
 * Fixed-height status bar (footer).
 *
 * Layout (single line, flexDirection="row", space-between):
 *   Left:   session name + (agentId)
 *   Right:  typing/compacting badge | Ctrl+K helper | NATS status dot
 */
export function StatusBar({
  sessionName,
  agentId,
  isConnected,
  model,
  isTyping,
  isCompacting,
}: StatusBarProps) {
  const statusDot = isConnected ? "\u25CF" : "\u25CB";
  const modelLabel = model ?? "sonnet";

  return (
    <box
      height={1}
      width="100%"
      flexDirection="row"
      justifyContent="space-between"
      bg="gray"
    >
      <box flexDirection="row">
        <text content={` ${sessionName}`} fg="cyan" bold />
        <text content={` (${agentId})`} fg="white" />
        <text content={`  ${modelLabel}`} fg="yellow" />
      </box>
      <box flexDirection="row">
        {isCompacting && (
          <text content="compacting  " fg="magenta" bold />
        )}
        {isTyping && !isCompacting && (
          <text content="typing...  " fg="yellow" bold />
        )}
        <text
          content={`${statusDot} `}
          fg={isConnected ? "green" : "red"}
          bold
        />
      </box>
    </box>
  );
}

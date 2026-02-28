/** @jsxImportSource @opentui/react */

import type { TokenUsage } from "../hooks/useNats.js";

export interface StatusBarProps {
  sessionName: string;
  agentId: string;
  isConnected: boolean;
  model: string | null;
  isTyping: boolean;
  isCompacting: boolean;
  totalTokens: TokenUsage;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Fixed-height status bar (footer).
 *
 * Layout (single line, flexDirection="row", space-between):
 *   Left:   session name + (agentId) + model
 *   Right:  context tokens | compacting badge | NATS status dot
 */
export function StatusBar({
  sessionName,
  agentId,
  isConnected,
  model,
  isTyping: _isTyping,
  isCompacting,
  totalTokens,
}: StatusBarProps) {
  const statusDot = isConnected ? "\u25CF" : "\u25CB";
  const modelLabel = model ?? "unknown";

  const ctx = totalTokens.contextTokens;

  return (
    <box height={1} width="100%" flexDirection="row" justifyContent="space-between" bg="gray">
      <box flexDirection="row">
        <text content={` ${sessionName}`} fg="cyan" bold />
        <text content={` (${agentId})`} fg="white" />
        <text content={`  ${modelLabel}`} fg="yellow" />
      </box>
      <box flexDirection="row">
        {isCompacting && <text content="compacting  " fg="magenta" bold />}
        {ctx > 0 && <text content={`\u25A6 ${formatTokens(ctx)} `} fg="cyan" />}
        <text content={`${statusDot} `} fg={isConnected ? "green" : "red"} bold />
      </box>
    </box>
  );
}

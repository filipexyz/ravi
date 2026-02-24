/** @jsxImportSource @opentui/react */

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "switch", description: "Switch session (Ctrl+K)" },
  { name: "clear", description: "Clear chat messages" },
  { name: "help", description: "Show available commands" },
  { name: "model", description: "Change model" },
];

export function filterCommands(query: string): SlashCommand[] {
  if (!query) return SLASH_COMMANDS;
  const lower = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().includes(lower));
}

interface SlashMenuProps {
  query: string;
  selectedIndex: number;
}

/**
 * Dropdown overlay that appears above the input bar when the user types `/`.
 * Pure visual component — keyboard handling lives in InputBar.
 */
export function SlashMenu({ query, selectedIndex }: SlashMenuProps) {
  const filtered = filterCommands(query);
  if (filtered.length === 0) return null;

  const clamped = Math.min(selectedIndex, filtered.length - 1);

  return (
    <box
      position="absolute"
      bottom={3}
      left={0}
      width="40%"
      height={filtered.length + 2}
      flexDirection="column"
      border
      borderColor="cyan"
      bg="black"
    >
      {filtered.map((cmd, i) => {
        const isSelected = i === clamped;
        const prefix = isSelected ? "> " : "  ";
        return (
          <text
            key={cmd.name}
            content={`${prefix}/${cmd.name}  ${cmd.description}`}
            fg={isSelected ? "cyan" : "white"}
            bold={isSelected}
          />
        );
      })}
    </box>
  );
}

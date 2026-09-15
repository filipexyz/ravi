export const TUI_SESSION_USAGE = "Usage: ravi tui <session>";

export function requireTuiSessionName(session?: string | null): string {
  const trimmed = session?.trim();
  if (!trimmed) {
    throw new Error(TUI_SESSION_USAGE);
  }
  return trimmed;
}

export function resolveTuiSessionArg(argv: string[] = process.argv): string {
  return requireTuiSessionName(argv[2]);
}

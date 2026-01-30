/**
 * CLI Utilities - Shared helpers
 */

/**
 * Extract option name from flags string.
 * e.g., "-f, --force" -> "force"
 */
export function extractOptionName(flags: string): string {
  const match = flags.match(/--([a-zA-Z-]+)/);
  if (match) {
    // Convert kebab-case to camelCase
    return match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  // Fall back to short option
  const shortMatch = flags.match(/-([a-zA-Z])/);
  return shortMatch ? shortMatch[1] : "";
}

/**
 * Check if option is boolean (no value placeholder).
 */
export function isBooleanOption(flags: string): boolean {
  return !/<[^>]+>/.test(flags) && !/\[[^\]]+\]/.test(flags);
}

/**
 * Infer option type from flags.
 */
export function inferOptionType(flags: string): string {
  return isBooleanOption(flags) ? "boolean" : "string";
}

/**
 * Bash Permission Reference Lists
 *
 * Default allowlist used by REBAC templates (safe-executables).
 */

// ============================================================================
// Default Lists
// ============================================================================

/**
 * Safe executables for REBAC template "safe-executables".
 * These are commonly needed for development and are considered low-risk.
 */
export function getDefaultAllowlist(): string[] {
  return [
    // File operations (read-only or safe)
    "ls",
    "cat",
    "head",
    "tail",
    "find",
    "mkdir",
    "cp",
    "mv",
    "touch",
    "stat",
    "file",
    "wc",
    "sort",
    "uniq",
    "tee",

    // Git
    "git",

    // Text processing
    "grep",
    "rg", // ripgrep
    "awk",
    "sed",
    "diff",
    "jq",
    "yq",
    "cut",
    "tr",
    "xargs",

    // Node/JS
    "node",
    "npm",
    "npx",
    "bun",
    "bunx",
    "yarn",
    "pnpm",
    "tsx",
    "ts-node",

    // Python
    "python",
    "python3",
    "pip",
    "pip3",
    "poetry",
    "uv",

    // Build tools
    "make",
    "cargo",
    "go",
    "rustc",
    "gcc",
    "g++",
    "clang",

    // Testing
    "jest",
    "vitest",
    "pytest",
    "mocha",

    // Linting
    "eslint",
    "prettier",
    "biome",
    "ruff",
    "black",

    // Misc dev tools
    "echo",
    "printf",
    "date",
    "pwd",
    "whoami",
    "which",
    "env",
    "dirname",
    "basename",
    "realpath",
    "true",
    "false",
    "test",
    "[",
  ];
}

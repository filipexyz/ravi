/**
 * Bash Permission Checker
 *
 * Validates bash commands against agent's BashConfig.
 */

import type { BashConfig, PermissionCheckResult } from "./types.js";
import {
  checkDangerousPatterns,
  parseBashCommand,
  UNCONDITIONAL_BLOCKS,
} from "./parser.js";

// ============================================================================
// Default Lists
// ============================================================================

/**
 * Safe executables for allowlist mode (init strict).
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

/**
 * Dangerous executables for denylist mode (init).
 * These are blocked by default due to security risks.
 */
export function getDefaultDenylist(): string[] {
  return [
    // Destructive file operations
    "rm",
    "rmdir",
    "shred",
    "dd",

    // System administration
    "sudo",
    "su",
    "chmod",
    "chown",
    "chgrp",
    "systemctl",
    "service",
    "mount",
    "umount",

    // Network operations
    "curl",
    "wget",
    "nc",
    "netcat",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "ftp",
    "telnet",

    // Package managers (system-level)
    "apt",
    "apt-get",
    "brew",
    "yum",
    "dnf",
    "pacman",
    "snap",
    "flatpak",

    // Containers
    "docker",
    "podman",
    "kubectl",
    "helm",

    // Process control
    "kill",
    "killall",
    "pkill",

    // Dangerous utilities
    "reboot",
    "shutdown",
    "halt",
    "poweroff",
    "mkfs",
    "fdisk",
    "parted",
  ];
}

// ============================================================================
// Permission Checking
// ============================================================================

/**
 * Check if a command is allowed based on the agent's bash config.
 *
 * Defense in depth:
 * 1. Check for dangerous patterns (injection attempts)
 * 2. Parse command to extract all executables
 * 3. Check each executable against unconditional blocks
 * 4. Check each executable against the config (allowlist/denylist)
 */
export function checkBashPermission(
  command: string,
  config: BashConfig | undefined
): PermissionCheckResult {
  // No config = bypass mode (allow all)
  if (!config || config.mode === "bypass") {
    return { allowed: true };
  }

  // Step 1: Check for dangerous patterns
  const patternCheck = checkDangerousPatterns(command);
  if (!patternCheck.safe) {
    return {
      allowed: false,
      reason: patternCheck.reason,
    };
  }

  // Step 2: Parse command to extract executables
  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    // Fail-closed: if parsing fails, deny the command
    return {
      allowed: false,
      reason: parsed.error || "Failed to parse command",
    };
  }

  // Step 3 & 4: Check each executable
  const blockedExecutables: string[] = [];
  const blockedReasons: string[] = [];

  for (const exec of parsed.executables) {
    // Check unconditional blocks first
    if (UNCONDITIONAL_BLOCKS.has(exec)) {
      blockedExecutables.push(exec);
      blockedReasons.push(`${exec} is unconditionally blocked`);
      continue;
    }

    // Check against config
    if (config.mode === "allowlist") {
      const allowlist = config.allowlist || [];
      if (!allowlist.includes(exec)) {
        blockedExecutables.push(exec);
        blockedReasons.push(`${exec} is not in allowlist`);
      }
    } else if (config.mode === "denylist") {
      const denylist = config.denylist || [];
      if (denylist.includes(exec)) {
        blockedExecutables.push(exec);
        blockedReasons.push(`${exec} is in denylist`);
      }
    }
  }

  if (blockedExecutables.length > 0) {
    return {
      allowed: false,
      blockedExecutables,
      reason: blockedReasons.join("; "),
    };
  }

  return { allowed: true };
}

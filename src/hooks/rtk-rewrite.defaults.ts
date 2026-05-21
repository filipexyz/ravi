import type { RtkRule } from "./rtk-rewrite.types.js";

export const DEFAULT_RTK_RULES: RtkRule[] = [
  // grep variants — single rewrite covers -q, -r, -E, -oE, -rn, -rln, -c, etc.
  { id: "grep", match: /^grep(\s|$)/, rewrite: "rtk grep$1" },

  // ls and find
  { id: "ls-la", match: /^ls\s+-la\b/, rewrite: "rtk ls -la" },
  { id: "find-home", match: /^find\s+\/home\b/, rewrite: "rtk find /home" },

  // lint (covers `eslint`, `eslint .`, `eslint src/`, `eslint . --max-warnings 0`)
  { id: "eslint", match: /^eslint(\s|$)/, rewrite: "rtk lint eslint$1" },

  // ps via TOML filter
  { id: "ps-aux", match: /^ps\s+aux\b/, rewrite: "rtk:toml ps aux" },
  { id: "ps-ef", match: /^ps\s+-ef\b/, rewrite: "rtk:toml ps -ef" },

  // diff / rsync via TOML
  { id: "diff-u", match: /^diff\s+-u\b/, rewrite: "rtk:toml diff -u" },
  { id: "rsync", match: /^rsync\s+-av\s+--delete\s+--dry-run\b/, rewrite: "rtk:toml rsync -av --delete --dry-run" },

  // du
  { id: "du-sh", match: /^du\s+-sh\b/, rewrite: "rtk:toml du -sh" },
];

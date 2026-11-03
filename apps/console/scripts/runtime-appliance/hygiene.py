#!/usr/bin/env python3
"""Safe image-tree hygiene scanner. Reports paths/categories, never values."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


SECRET_PATTERNS = {
    "ravi_context_key": re.compile(rb"rctx_[A-Za-z0-9_-]{16,}"),
    "deck_context_key": re.compile(rb"dctx_[A-Za-z0-9_-]{16,}"),
    "openai_key": re.compile(rb"(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])"),
    "private_key": re.compile(
        rb"-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----\r?\n"
        rb"(?:[A-Za-z0-9+/=]{16,}\r?\n){2,}"
        rb"-----END (?:OPENSSH |RSA |EC |)PRIVATE KEY-----"
    ),
}
FORBIDDEN_NAMES = {
    ".env",
    "auth.json",
    "credentials.json",
    "ravi.db",
    "ravi.db-wal",
    "ravi.db-shm",
    "known_hosts",
    "authorized_keys",
}
FORBIDDEN_PREFIXES = ("ssh_host_", "id_rsa", "id_ed25519")
SKIP_DIRS = {"proc", "sys", "dev", "run"}


def main() -> None:
    parser = argparse.ArgumentParser(description="Scan a staged Ravi appliance tree")
    parser.add_argument("root")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    findings = scan(root)
    result = {"ok": len(findings) == 0, "findingCount": len(findings), "findings": findings}
    print(json.dumps(result, indent=2, sort_keys=True))
    raise SystemExit(0 if result["ok"] else 1)


def scan(root: Path) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for current, dirs, files in os.walk(root):
        relative_dir = Path(current).relative_to(root)
        dirs[:] = [name for name in dirs if not (relative_dir == Path(".") and name in SKIP_DIRS)]
        for name in files:
            path = Path(current) / name
            relative = str(path.relative_to(root))
            if path.is_symlink():
                continue
            lowered = name.lower()
            if lowered in FORBIDDEN_NAMES or lowered.startswith(".env.") or lowered.startswith(FORBIDDEN_PREFIXES):
                if path.stat().st_size > 0 or lowered not in {"authorized_keys"}:
                    findings.append({"category": "forbidden_path", "path": relative})
                    continue
            if relative == "etc/machine-id" and path.read_bytes().strip():
                findings.append({"category": "machine_identity", "path": relative})
                continue
            try:
                with path.open("rb") as handle:
                    sample = handle.read(8 * 1024 * 1024)
            except OSError:
                findings.append({"category": "unreadable_file", "path": relative})
                continue
            if b"\x00" in sample:
                continue
            for category, pattern in SECRET_PATTERNS.items():
                if pattern.search(sample):
                    findings.append({"category": category, "path": relative})
    return sorted(findings, key=lambda item: (item["category"], item["path"]))


if __name__ == "__main__":
    main()

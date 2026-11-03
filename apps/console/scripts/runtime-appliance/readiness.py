#!/usr/bin/env python3
"""Machine-readable readiness probe for a booted Managed Ravi appliance."""

from __future__ import annotations

import email.utils
import json
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from datetime import timezone
from pathlib import Path
from typing import Any, Callable


CLOCK_URL = "https://www.cloudflare.com/"
CLOCK_COMMAND_TIMEOUT_SECONDS = 3
COMMAND_TIMEOUT_SECONDS = 5
DNS_TIMEOUT_SECONDS = 5
READINESS_PATH = Path("/run/ravi/readiness.json")


def main() -> None:
    checks: dict[str, dict[str, Any]] = {}
    probes: list[tuple[str, Callable[[], dict[str, Any]]]] = [
        ("contract", lambda: file_json_check(Path("/etc/ravi-appliance/contract.json"))),
        ("identity", lambda: file_json_check(Path("/var/lib/ravi/identity.json"))),
        (
            "bootstrap_inputs_erased",
            lambda: {
                "ok": not Path("/run/ravi-bootstrap/payload.json").exists()
                and not Path("/run/ravi-bootstrap/payload.sig").exists()
            },
        ),
        ("persistent_state", persistent_state_check),
        ("machine_identity", lambda: {"ok": bool(read_text(Path("/etc/machine-id")).strip())}),
        ("ssh_identity", lambda: {"ok": any(Path("/etc/ssh").glob("ssh_host_*_key"))}),
        ("single_ravi_install", single_ravi_install_check),
        ("default_route", default_route_check),
        ("dns_resolution", lambda: dns_check("api.openai.com")),
        ("nats_loopback", lambda: tcp_check("127.0.0.1", 4222)),
        ("sdk_loopback", lambda: tcp_check("127.0.0.1", int(os.environ.get("RAVI_HTTP_PORT", "4211")))),
        ("codex_installed", lambda: command_check(["/usr/local/bin/codex", "--version"])),
        (
            "ravi_daemon",
            lambda: command_check(["systemctl", "is-active", "--quiet", "ravi-appliance.service"]),
        ),
        ("initial_agent", initial_agent_check),
        ("clock_synchronized", clock_check),
    ]
    write_readiness(False, checks, code="readiness_pending")
    for name, probe in probes:
        write_readiness(False, checks, code="readiness_pending", current_check=name)
        checks[name] = safe_probe(probe)

    contract = read_json(Path("/etc/ravi-appliance/contract.json")) or {}
    require_codex_auth = bool(contract.get("runtime", {}).get("requireCodexAuth", False))
    write_readiness(False, checks, code="readiness_pending", current_check="codex_authenticated")
    checks["codex_authenticated"] = safe_probe(provider_broker_check)
    if not require_codex_auth:
        checks["codex_authenticated"]["required"] = False

    ready = all(value.get("ok") for key, value in checks.items() if key != "codex_authenticated" or require_codex_auth)
    write_readiness(ready, checks, code=None if ready else "readiness_failed")
    write_status(ready)
    print(json.dumps({"ready": ready, "checks": checks}, sort_keys=True))
    raise SystemExit(0 if ready else 1)


def safe_probe(probe: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        result = probe()
    except (OSError, subprocess.SubprocessError, ValueError):
        return {"ok": False}
    return result if isinstance(result, dict) and isinstance(result.get("ok"), bool) else {"ok": False}


def write_readiness(
    ready: bool,
    checks: dict[str, dict[str, Any]],
    *,
    code: str | None,
    current_check: str | None = None,
) -> None:
    result: dict[str, Any] = {"code": code, "ready": ready, "checks": checks}
    if current_check:
        result["currentCheck"] = current_check
    READINESS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = READINESS_PATH.with_suffix(".json.tmp")
    temporary.write_text(f"{json.dumps(result, sort_keys=True)}\n", encoding="utf-8")
    temporary.replace(READINESS_PATH)


def file_json_check(path: Path) -> dict[str, Any]:
    value = read_json(path)
    return {"ok": value is not None}


def single_ravi_install_check() -> dict[str, Any]:
    current = Path("/opt/ravi/current")
    releases = list(Path("/opt/ravi/releases").glob("*")) if Path("/opt/ravi/releases").exists() else []
    return {"ok": current.is_symlink() and len(releases) == 1, "releaseCount": len(releases)}


def persistent_state_check() -> dict[str, Any]:
    marker = read_json(Path("/var/lib/ravi/.ravi-state-volume.json"))
    result = run_command(
        ["findmnt", "-rn", "--target", "/var/lib/ravi", "--output", "TARGET,SOURCE"],
    )
    if result is None:
        return {"ok": False, "mounted": False, "marker": marker is not None}
    fields = result.stdout.strip().split()
    if result.returncode != 0 or len(fields) != 2 or fields[0] != "/var/lib/ravi":
        return {"ok": False, "mounted": False, "marker": marker is not None}
    label = run_command(
        ["blkid", "-s", "LABEL", "-o", "value", fields[1]],
    )
    if label is None:
        return {"ok": False, "mounted": True, "marker": marker is not None, "label": None}
    return {
        "ok": marker is not None and label.returncode == 0 and label.stdout.strip() == "RAVI_STATE",
        "mounted": True,
        "marker": marker is not None,
        "label": label.stdout.strip() if label.returncode == 0 else None,
    }


def initial_agent_check() -> dict[str, Any]:
    contract = read_json(Path("/etc/ravi-appliance/contract.json")) or {}
    agent_id = contract.get("runtime", {}).get("initialAgentId")
    if not isinstance(agent_id, str) or not agent_id:
        return {"ok": False}
    workspace = Path("/srv/ravi/agents") / agent_id
    database = Path(os.environ.get("RAVI_STATE_DIR", "/var/lib/ravi/.ravi")) / "ravi.db"
    return {"ok": workspace.is_dir() and database.is_file(), "agentId": agent_id}


def provider_broker_check(
    state_path: Path = Path("/var/lib/ravi/provisioning/provider-broker.json"),
    config_path: Path = Path("/var/lib/ravi/.codex/config.toml"),
) -> dict[str, Any]:
    state = read_json(state_path)
    if not state or state.get("schemaVersion") != "ravi.managed-appliance.provider-broker/v1":
        return {"ok": False, "configured": False}
    health_url = state.get("healthUrl")
    base_url = state.get("baseUrl")
    config = read_text(config_path)
    if (
        not isinstance(health_url, str)
        or not isinstance(base_url, str)
        or f'base_url = "{base_url}"' not in config
        or "requires_openai_auth = false" not in config
    ):
        return {"ok": False, "configured": False}
    try:
        request = urllib.request.Request(
            health_url,
            method="GET",
            headers={"Accept": "application/json", "User-Agent": "ravi-appliance-readiness/1"},
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            if response.status != 200:
                return {"ok": False, "configured": True}
            payload = json.loads(response.read(4096))
        return {
            "ok": isinstance(payload, dict) and payload.get("ok") is True,
            "configured": True,
            "kind": "host_responses_proxy",
        }
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError):
        return {"ok": False, "configured": True}


def clock_check() -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["timedatectl", "show", "--property=NTPSynchronized", "--value"],
            capture_output=True,
            text=True,
            check=False,
            timeout=CLOCK_COMMAND_TIMEOUT_SECONDS,
        )
        synchronized = result.returncode == 0 and result.stdout.strip().lower() == "yes"
    except (OSError, subprocess.TimeoutExpired):
        synchronized = False
    if synchronized:
        return {"ok": True, "ntpSynchronized": True, "epochSeconds": int(time.time())}
    offset = https_clock_offset(CLOCK_URL)
    return {
        "ok": offset is not None and abs(offset) <= 120,
        "ntpSynchronized": False,
        "offsetSeconds": round(offset, 3) if offset is not None else None,
        "source": CLOCK_URL,
        "epochSeconds": int(time.time()),
    }


def https_clock_offset(url: str) -> float | None:
    try:
        request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "ravi-appliance-readiness/1"})
        sent = time.time()
        with urllib.request.urlopen(request, timeout=3) as response:
            date_header = response.headers.get("Date")
        received = time.time()
        if not date_header:
            return None
        server_time = email.utils.parsedate_to_datetime(date_header)
        if server_time.tzinfo is None:
            server_time = server_time.replace(tzinfo=timezone.utc)
        return server_time.timestamp() - ((sent + received) / 2)
    except (OSError, TypeError, ValueError, urllib.error.URLError):
        return None


def default_route_check() -> dict[str, Any]:
    result = run_command(["ip", "-4", "route", "show", "default"])
    if result is None:
        return {"ok": False}
    fields = result.stdout.strip().split()
    return {"ok": result.returncode == 0 and len(fields) >= 5 and fields[0] == "default"}


def dns_check(host: str) -> dict[str, Any]:
    result = run_command(["getent", "ahostsv4", host], timeout=DNS_TIMEOUT_SECONDS)
    return {"ok": result is not None and result.returncode == 0 and bool(result.stdout.strip()), "host": host}


def tcp_check(host: str, port: int) -> dict[str, Any]:
    try:
        with socket.create_connection((host, port), timeout=2):
            return {"ok": True, "endpoint": f"{host}:{port}"}
    except OSError:
        return {"ok": False, "endpoint": f"{host}:{port}"}


def command_check(command: list[str], user: str | None = None) -> dict[str, Any]:
    actual = command
    if user:
        actual = ["runuser", "-u", user, "--", "env", "HOME=/var/lib/ravi", "PATH=/usr/local/bin:/usr/bin:/bin", *command]
    try:
        result = subprocess.run(
            actual,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=15,
            cwd="/",
        )
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "exitCode": None}
    return {"ok": result.returncode == 0, "exitCode": result.returncode}


def run_command(
    command: list[str], *, timeout: int = COMMAND_TIMEOUT_SECONDS
) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
            cwd="/",
        )
    except (OSError, subprocess.SubprocessError):
        return None


def write_status(ready: bool) -> None:
    status_path = Path("/var/lib/ravi/provisioning/status.json")
    current = read_json(status_path) or {}
    current.update(
        {
            "ready": ready,
            "phase": "ready" if ready else "readiness_failed",
            "code": None if ready else "readiness_failed",
            "updatedAtEpochSeconds": int(time.time()),
        }
    )
    temporary = status_path.with_suffix(".json.tmp")
    temporary.write_text(f"{json.dumps(current, sort_keys=True)}\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(status_path)


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Configure the deterministic outbound network for a Firecracker appliance."""

from __future__ import annotations

import ipaddress
import os
import subprocess
import time
from pathlib import Path


class NetworkError(RuntimeError):
    pass


def main() -> None:
    interface = os.environ.get("RAVI_NETWORK_INTERFACE", "eth0")
    address = wait_for_address(interface)
    gateway = derive_gateway(address)
    run_checked(["ip", "route", "replace", "default", "via", gateway, "dev", interface])
    ensure_resolver(Path("/etc/resolv.conf"), os.environ.get("RAVI_DNS_SERVERS", "1.1.1.1,9.9.9.9"))


def wait_for_address(interface: str, attempts: int = 50) -> str:
    for _ in range(attempts):
        result = subprocess.run(
            ["ip", "-4", "-o", "address", "show", "dev", interface, "scope", "global"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            fields = result.stdout.split()
            if len(fields) >= 4:
                return fields[3]
        time.sleep(0.2)
    raise NetworkError("network_address_missing")


def derive_gateway(address: str) -> str:
    try:
        interface = ipaddress.ip_interface(address)
    except ValueError as error:
        raise NetworkError("network_address_invalid") from error
    if interface.version != 4 or interface.network.prefixlen != 30:
        raise NetworkError("network_prefix_unsupported")
    gateway = interface.network.network_address + 1
    if gateway == interface.ip:
        raise NetworkError("network_gateway_conflict")
    return str(gateway)


def ensure_resolver(path: Path, value: str) -> None:
    current = path.read_text(encoding="utf-8") if path.exists() else ""
    if any(line.strip().startswith("nameserver ") for line in current.splitlines()):
        return
    servers: list[str] = []
    for item in value.split(","):
        candidate = item.strip()
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError as error:
            raise NetworkError("dns_server_invalid") from error
        if address.version != 4:
            raise NetworkError("dns_server_invalid")
        servers.append(candidate)
    if not servers:
        raise NetworkError("dns_server_missing")
    path.write_text(
        "".join(f"nameserver {server}\n" for server in servers) + "options timeout:2 attempts:2\n",
        encoding="utf-8",
    )
    path.chmod(0o644)


def run_checked(command: list[str]) -> None:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise NetworkError("network_route_failed")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""P0 outbound runtime-hostd smoke runner.

This script intentionally uses only Python stdlib so the initial Ubuntu host can
run a Console -> hostd -> lease -> event smoke without installing Bun/Node.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any


JsonObject = dict[str, Any]


def main() -> None:
    parser = argparse.ArgumentParser(description="Ravi runtime-hostd P0 smoke")
    subparsers = parser.add_subparsers(dest="command", required=True)

    inventory_parser = subparsers.add_parser("inventory")
    inventory_parser.add_argument("--hostname", default="")

    smoke_parser = subparsers.add_parser("smoke")
    smoke_parser.add_argument("--console-url", default=os.environ.get("CONSOLE_URL", ""))
    smoke_parser.add_argument("--organization-id", default=os.environ.get("RAVI_RUNTIME_ORGANIZATION_ID", ""))
    smoke_parser.add_argument("--project-id", default=os.environ.get("RAVI_RUNTIME_PROJECT_ID", ""))
    smoke_parser.add_argument("--token", default=os.environ.get("RAVI_RUNTIME_CONTROL_TOKEN", ""))
    smoke_parser.add_argument("--hostname", default="")
    smoke_parser.add_argument("--sandbox-id", default="")
    smoke_parser.add_argument("--region", default=os.environ.get("RAVI_RUNTIME_REGION", "bhs"))
    smoke_parser.add_argument("--runtime-provider", default=os.environ.get("RAVI_RUNTIME_PROVIDER", "codex"))
    smoke_parser.add_argument("--runtime-model", default=os.environ.get("RAVI_RUNTIME_MODEL", ""))
    smoke_parser.add_argument("--session-key", default=os.environ.get("RAVI_RUNTIME_SESSION_KEY", "agent:ravi-agents-cloud:p0-smoke"))
    smoke_parser.add_argument("--vercel-bypass-secret", default=os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", ""))

    args = parser.parse_args()

    if args.command == "inventory":
        print(json.dumps(read_inventory(args.hostname), indent=2, sort_keys=True))
        return

    if args.command == "smoke":
        summary = run_smoke(args)
        print(json.dumps(summary, indent=2, sort_keys=True))
        return


def run_smoke(args: argparse.Namespace) -> JsonObject:
    console_url = require_config(args.console_url.rstrip("/"), "console-url")
    control_token = require_config(args.token, "token")
    organization_id = require_config(args.organization_id, "organization-id")
    sandbox_id = args.sandbox_id or f"p0-smoke-{uuid.uuid4()}"
    inventory = read_inventory(args.hostname)
    image_name = "ravi-runtime-hostd"
    image_version = "p0-smoke"

    host = post_json(
        console_url,
        "/api/internal/runtime/hosts/register",
        {
            "capacity": inventory["capacity"],
            "displayName": inventory["hostname"],
            "environment": "development",
            "health": inventory["health"],
            "hostname": inventory["hostname"],
            "placementClasses": inventory["placementClasses"],
            "provider": "ovh",
            "region": args.region or None,
            "status": "active",
        },
        control_token=control_token,
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )["host"]
    host_id = require_response_id(host.get("id"), "host.id")

    post_json(
        console_url,
        "/api/internal/runtime/hosts/heartbeat",
        {
            "capacity": inventory["capacity"],
            "health": {**inventory["health"], "lastSmokeStartedAt": now_iso()},
            "hostId": host_id,
            "placementClasses": inventory["placementClasses"],
            "status": "active",
        },
        control_token=control_token,
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )

    image = post_json(
        console_url,
        "/api/internal/runtime/images/register",
        {
            "architecture": inventory["architecture"],
            "baseOs": "host-process-smoke",
            "digest": stable_image_digest(image_name, image_version, inventory["architecture"]),
            "kernelRef": "host-process-smoke",
            "name": image_name,
            "providerSupport": {args.runtime_provider: True, "smoke": True},
            "rootfsRef": "host-process-smoke",
            "status": "active",
            "version": image_version,
        },
        control_token=control_token,
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )["image"]
    image_id = require_response_id(image.get("id"), "image.id")

    lease_response = post_json(
        console_url,
        "/api/internal/runtime/leases/request",
        {
            "hostId": host_id,
            "imageId": image_id,
            "leaseTtlSeconds": 900,
            "limits": {
                "driver": "process",
                "memoryMb": 512,
                "vcpus": 1,
                "wallClockSeconds": 60,
            },
            "organizationId": organization_id,
            "placement": "cloud",
            "projectId": args.project_id or None,
            "runtimeModel": args.runtime_model or None,
            "runtimeProvider": args.runtime_provider,
            "safeMetadata": {"hostd": "p0", "smoke": True},
            "sessionKey": args.session_key or None,
        },
        control_token=control_token,
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )
    lease_id = require_response_id(lease_response["lease"].get("id"), "lease.id")
    lease_token = require_lease_token(lease_response.get("leaseToken"))

    post_json(
        console_url,
        "/api/internal/runtime/leases/claim",
        {
            "hostId": host_id,
            "leaseToken": lease_token,
            "sandboxId": sandbox_id,
        },
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )

    validate_response = post_json(
        console_url,
        "/api/internal/runtime/leases/validate",
        {
            "leaseToken": lease_token,
            "sandboxId": sandbox_id,
        },
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )
    managed_session_id = require_response_id(
        validate_response.get("managedRuntimeSessionId"),
        "managedRuntimeSessionId",
    )

    event_response = post_json(
        console_url,
        "/api/internal/runtime/events",
        {
            "events": build_events(managed_session_id, args.runtime_provider, sandbox_id),
            "leaseToken": lease_token,
            "sandboxId": sandbox_id,
        },
        vercel_bypass_secret=args.vercel_bypass_secret or None,
    )
    if int(event_response.get("accepted", 0)) < 1:
        raise RuntimeError("runtime_hostd_no_events_accepted")

    return {
        "consoleUrl": console_url,
        "driver": "process",
        "hostId": host_id,
        "imageId": image_id,
        "leaseId": lease_id,
        "managedRuntimeSessionId": managed_session_id,
        "sandboxId": sandbox_id,
        "status": "completed",
    }


def read_inventory(hostname_override: str = "") -> JsonObject:
    architecture = normalize_architecture(platform.machine())
    cpu_count = os.cpu_count() or 1
    total_memory_mb, free_memory_mb = read_memory_mb()
    kvm_available = Path("/dev/kvm").exists()
    virtualization_count = read_virtualization_count()
    firecracker_path = shutil.which("firecracker")
    jailer_path = shutil.which("jailer")
    placement_classes = [
        "p0",
        "outbound-hostd",
        "process-smoke",
        architecture,
    ]
    if kvm_available:
        placement_classes.append("kvm")
    if firecracker_path:
        placement_classes.append("firecracker")

    return {
        "architecture": architecture,
        "capacity": {
            "cpuCount": cpu_count,
            "freeMemoryMb": free_memory_mb,
            "totalMemoryMb": total_memory_mb,
        },
        "health": {
            "firecrackerPath": firecracker_path,
            "jailerPath": jailer_path,
            "kernel": f"{platform.system()} {platform.release()}",
            "kvmAvailable": kvm_available,
            "platform": sys.platform,
            "processUser": os.environ.get("USER") or os.environ.get("LOGNAME"),
            "pythonVersion": platform.python_version(),
            "virtualizationCount": virtualization_count,
        },
        "hostname": hostname_override.strip() or socket.gethostname(),
        "placementClasses": placement_classes,
    }


def build_events(managed_session_id: str, runtime_provider: str, sandbox_id: str) -> list[JsonObject]:
    prefix = f"hostd-p0-{sandbox_id}"
    return [
        {
            "eventType": "thread.started",
            "safePayload": {
                "managedRuntimeSessionId": managed_session_id,
                "sandboxDriver": "process",
                "smoke": True,
            },
            "sequence": 1,
            "severity": "info",
            "sourceEventId": f"{prefix}-thread-started",
        },
        {
            "eventType": "turn.started",
            "safePayload": {
                "runtimeProvider": runtime_provider,
                "sandboxDriver": "process",
                "smoke": True,
            },
            "sequence": 2,
            "severity": "info",
            "sourceEventId": f"{prefix}-turn-started",
        },
        {
            "eventType": "status",
            "safePayload": {
                "message": "runtime-hostd process smoke executed",
                "sandboxDriver": "process",
                "smoke": True,
            },
            "sequence": 3,
            "severity": "info",
            "sourceEventId": f"{prefix}-status",
        },
        {
            "eventType": "assistant.message",
            "safePayload": {
                "text": "Ravi managed runtime P0 smoke completed.",
                "smoke": True,
            },
            "sequence": 4,
            "severity": "info",
            "sourceEventId": f"{prefix}-assistant-message",
        },
        {
            "eventType": "turn.complete",
            "safePayload": {
                "sandboxDriver": "process",
                "smoke": True,
            },
            "sequence": 5,
            "severity": "info",
            "sourceEventId": f"{prefix}-turn-complete",
        },
    ]


def post_json(
    console_url: str,
    route: str,
    body: JsonObject,
    *,
    control_token: str | None = None,
    vercel_bypass_secret: str | None = None,
) -> JsonObject:
    headers = {"content-type": "application/json"}
    if control_token:
        headers["authorization"] = f"Bearer {control_token}"
    if vercel_bypass_secret:
        headers["x-vercel-protection-bypass"] = vercel_bypass_secret
    request = urllib.request.Request(
        f"{console_url}{route}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        payload = safe_json(error.read().decode("utf-8"))
        code = payload.get("code") or "runtime_api_error"
        request_id = payload.get("requestId") or ""
        raise RuntimeError(
            f"runtime_hostd_api_error route={route} status={error.code} code={code} requestId={request_id}",
        ) from error


def safe_json(text: str) -> JsonObject:
    try:
        parsed = json.loads(text or "{}")
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def read_memory_mb() -> tuple[int | None, int | None]:
    meminfo = Path("/proc/meminfo")
    if not meminfo.exists():
        return None, None
    values: dict[str, int] = {}
    for line in meminfo.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 2:
            values[parts[0].rstrip(":")] = int(parts[1])
    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    return (
        total // 1024 if total else None,
        available // 1024 if available else None,
    )


def read_virtualization_count() -> int | None:
    cpuinfo = Path("/proc/cpuinfo")
    if not cpuinfo.exists():
        return None
    text = cpuinfo.read_text(encoding="utf-8", errors="ignore")
    return text.count(" vmx ") + text.count(" svm ")


def normalize_architecture(value: str) -> str:
    if value in {"x86_64", "amd64"}:
        return "x86_64"
    if value in {"aarch64", "arm64"}:
        return "arm64"
    return value


def stable_image_digest(name: str, version: str, architecture: str) -> str:
    value = f"ravi-runtime-hostd-p0:{name}:{version}:{architecture}".encode("utf-8")
    return f"sha256:{hashlib.sha256(value).hexdigest()}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def require_config(value: str, name: str) -> str:
    if not value:
        raise RuntimeError(f"runtime_hostd_missing_config:{name}")
    return value


def require_response_id(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise RuntimeError(f"runtime_hostd_missing_response:{name}")
    return value


def require_lease_token(value: Any) -> str:
    if not isinstance(value, str) or not value.startswith("ravi_rlt_"):
        raise RuntimeError("runtime_hostd_invalid_lease_token_response")
    return value


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

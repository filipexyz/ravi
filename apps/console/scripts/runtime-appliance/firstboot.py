#!/usr/bin/env python3
"""Fail-closed first boot for the Managed Ravi Firecracker appliance."""

from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import json
import os
import re
import secrets
import subprocess
import uuid
import urllib.parse
from pathlib import Path
from typing import Any


SCHEMA = "ravi.managed-appliance.bootstrap/v1"
MAX_TTL_SECONDS = 600
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*:[^,\s]{1,160}$")
MACHINE_ID_RE = re.compile(r"^[a-f0-9]{32}$")


class FirstBootError(RuntimeError):
    pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Managed Ravi appliance first boot")
    parser.add_argument("--root", default="/")
    parser.add_argument("--bootstrap-dir", default="/run/ravi-bootstrap")
    parser.add_argument("--now", default="")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    bootstrap_dir = rooted(root, args.bootstrap_dir)
    now = parse_time(args.now) if args.now else dt.datetime.now(dt.timezone.utc)

    try:
        result = provision(root, bootstrap_dir, now, validate_only=args.validate_only)
    except FirstBootError as error:
        code = str(error)
        write_failure(root, code)
        print(json.dumps({"ready": False, "code": code}, sort_keys=True))
        raise SystemExit(1) from error
    except Exception as error:
        code = "firstboot_internal_error"
        write_failure(root, code)
        print(json.dumps({"ready": False, "code": code}, sort_keys=True))
        raise SystemExit(1) from error

    print(json.dumps(result, sort_keys=True))


def provision(root: Path, bootstrap_dir: Path, now: dt.datetime, *, validate_only: bool) -> dict[str, Any]:
    contract_path = root / "etc/ravi-appliance/contract.json"
    payload_path = bootstrap_dir / "payload.json"
    signature_path = bootstrap_dir / "payload.sig"
    public_key_path = root / "etc/ravi-appliance/bootstrap-public.pem"
    consumed_dir = root / "var/lib/ravi/provisioning/consumed"
    identity_path = root / "var/lib/ravi/identity.json"

    contract = read_json(contract_path, "contract_missing")
    if identity_path.exists():
        if payload_path.exists() or signature_path.exists():
            raise FirstBootError("bootstrap_replayed")
        ensure_volatile_runtime_directories(root)
        return validate_existing_installation(root, contract)

    payload = read_json(payload_path, "bootstrap_missing")
    require_file(signature_path, "bootstrap_signature_missing")
    require_file(public_key_path, "bootstrap_public_key_missing")
    verify_signature(public_key_path, payload_path, signature_path)
    validate_payload(payload, contract, now)
    validate_state_volume(root, payload, contract)

    grant_id = require_string(payload, "grantId", "bootstrap_grant_invalid")
    consumed_path = consumed_dir / f"{grant_id}.json"
    if consumed_path.exists():
        raise FirstBootError("bootstrap_replayed")
    safe = {
        "ready": False,
        "phase": "validated",
        "grantId": grant_id,
        "instanceId": payload["bindings"]["instanceId"],
        "deckInstanceRef": payload["bindings"]["deckInstanceRef"],
        "vmId": payload["bindings"]["vmId"],
        "imageDigest": payload["bindings"]["imageDigest"],
    }
    if validate_only:
        return safe

    ensure_runtime_directories(root)
    machine_id = initialize_machine_identity(root, accept_systemd_generated=root == Path("/"))
    initialize_ssh_identity(root, payload.get("operatorSshPublicKey"))

    identity = {
        "schemaVersion": "ravi.managed-appliance.identity/v1",
        "instanceId": payload["bindings"]["instanceId"],
        "vmId": payload["bindings"]["vmId"],
        "hostId": payload["bindings"]["hostId"],
        "deckInstanceRef": payload["bindings"]["deckInstanceRef"],
        "imageDigest": payload["bindings"]["imageDigest"],
        "providerBrokerBaseUrl": provider_broker_base_url(payload),
        "machineId": machine_id,
        "installationId": f"rinst_{uuid.uuid4().hex}",
        "controllerId": f"rctl_{uuid.uuid4().hex}",
        "provisionedAt": format_time(now),
    }
    write_json(identity_path, identity, 0o600)
    if root == Path("/"):
        subprocess.run(["chown", "ravi:ravi", str(identity_path)], check=True)

    initialize_codex_provider(root, payload)
    controller = initialize_ravi(root, payload)
    consumed_dir.mkdir(parents=True, exist_ok=True)
    write_json(
        consumed_path,
        {"grantId": grant_id, "consumedAt": format_time(now), "instanceId": identity["instanceId"]},
        0o600,
    )
    write_json(
        root / "var/lib/ravi/provisioning/status.json",
        {"ready": False, "phase": "provisioned", "code": None, "updatedAt": format_time(now)},
        0o600,
    )
    erase_bootstrap_inputs(payload_path, signature_path)
    return {
        **safe,
        "phase": "provisioned",
        "installationId": identity["installationId"],
        "controllerContextId": controller["contextId"],
    }


def validate_payload(payload: dict[str, Any], contract: dict[str, Any], now: dt.datetime) -> None:
    if payload.get("schemaVersion") != SCHEMA:
        raise FirstBootError("bootstrap_schema_invalid")
    bindings = payload.get("bindings")
    if not isinstance(bindings, dict):
        raise FirstBootError("bootstrap_bindings_invalid")
    for key in ("hostId", "vmId", "instanceId", "deckInstanceRef"):
        if not isinstance(bindings.get(key), str) or not bindings[key]:
            raise FirstBootError(f"bootstrap_{key}_invalid")
    if bindings["deckInstanceRef"] != f"managed-{bindings['instanceId']}":
        raise FirstBootError("bootstrap_deck_instance_ref_mismatch")
    digest = bindings.get("imageDigest")
    if not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest):
        raise FirstBootError("bootstrap_image_digest_invalid")
    image = contract.get("image")
    if not isinstance(image, dict) or digest != image.get("digest"):
        raise FirstBootError("bootstrap_image_digest_mismatch")
    if payload.get("initialAgent", {}).get("provider") != "codex":
        raise FirstBootError("bootstrap_provider_unsupported")
    provider_broker_base_url(payload)
    controller = payload.get("controller")
    if not isinstance(controller, dict):
        raise FirstBootError("bootstrap_controller_invalid")
    if not isinstance(controller.get("label"), str) or not controller["label"].strip():
        raise FirstBootError("bootstrap_controller_invalid")
    claim_token_hash = controller.get("credentialClaimTokenHash")
    if not isinstance(claim_token_hash, str) or not DIGEST_RE.fullmatch(claim_token_hash):
        raise FirstBootError("bootstrap_controller_claim_invalid")
    capabilities = controller.get("capabilities")
    if (
        not isinstance(capabilities, list)
        or not 1 <= len(capabilities) <= 32
        or any(not isinstance(item, str) or not CAPABILITY_RE.fullmatch(item) for item in capabilities)
    ):
        raise FirstBootError("bootstrap_controller_capabilities_invalid")
    ttl_seconds = controller.get("ttlSeconds")
    if (
        not isinstance(ttl_seconds, int)
        or not 300 <= ttl_seconds <= 90 * 24 * 60 * 60
        or ttl_seconds % 60 != 0
    ):
        raise FirstBootError("bootstrap_controller_ttl_invalid")

    issued_at = parse_time(require_string(payload, "issuedAt", "bootstrap_time_invalid"))
    expires_at = parse_time(require_string(payload, "expiresAt", "bootstrap_time_invalid"))
    ttl = (expires_at - issued_at).total_seconds()
    if issued_at > now + dt.timedelta(seconds=30):
        raise FirstBootError("bootstrap_not_yet_valid")
    if expires_at <= now:
        raise FirstBootError("bootstrap_expired")
    if ttl <= 0 or ttl > MAX_TTL_SECONDS:
        raise FirstBootError("bootstrap_ttl_invalid")


def verify_signature(public_key: Path, payload: Path, signature: Path) -> None:
    result = subprocess.run(
        [
            "openssl",
            "pkeyutl",
            "-verify",
            "-pubin",
            "-inkey",
            str(public_key),
            "-rawin",
            "-in",
            str(payload),
            "-sigfile",
            str(signature),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise FirstBootError("bootstrap_signature_invalid")


def validate_state_volume(root: Path, payload: dict[str, Any], contract: dict[str, Any]) -> None:
    storage = contract.get("storage")
    if not isinstance(storage, dict):
        raise FirstBootError("state_contract_invalid")
    state_mount = storage.get("stateMount")
    state_label = storage.get("stateLabel")
    if state_mount != "/var/lib/ravi" or state_label != "RAVI_STATE":
        raise FirstBootError("state_contract_invalid")

    marker = read_json(rooted(root, f"{state_mount}/.ravi-state-volume.json"), "state_volume_missing")
    bindings = payload.get("bindings", {})
    for key in ("instanceId", "vmId", "imageDigest"):
        if marker.get(key) != bindings.get(key):
            raise FirstBootError(f"state_{key}_mismatch")

    if root == Path("/"):
        mounted = subprocess.run(
            ["findmnt", "-rn", "--target", state_mount, "--output", "TARGET,SOURCE"],
            capture_output=True,
            text=True,
            check=False,
        )
        if mounted.returncode != 0:
            raise FirstBootError("state_volume_not_mounted")
        fields = mounted.stdout.strip().split()
        if len(fields) != 2 or fields[0] != state_mount:
            raise FirstBootError("state_volume_not_mounted")
        label = subprocess.run(
            ["blkid", "-s", "LABEL", "-o", "value", fields[1]],
            capture_output=True,
            text=True,
            check=False,
        )
        if label.returncode != 0 or label.stdout.strip() != state_label:
            raise FirstBootError("state_volume_label_invalid")


def validate_existing_installation(root: Path, contract: dict[str, Any]) -> dict[str, Any]:
    identity = read_json(root / "var/lib/ravi/identity.json", "identity_invalid")
    status = read_json(root / "var/lib/ravi/provisioning/status.json", "provisioning_status_invalid")
    if status.get("phase") not in {"provisioned", "readiness_failed", "ready"}:
        raise FirstBootError("provisioning_status_invalid")
    payload_projection = {
        "bindings": {
            "instanceId": identity.get("instanceId"),
            "vmId": identity.get("vmId"),
            "imageDigest": identity.get("imageDigest"),
        }
    }
    validate_state_volume(root, payload_projection, contract)
    if identity.get("imageDigest") != contract.get("image", {}).get("digest"):
        raise FirstBootError("identity_image_digest_mismatch")
    validate_codex_provider_state(root, identity)
    return {
        "ready": False,
        "phase": "already_provisioned",
        "instanceId": identity.get("instanceId"),
        "vmId": identity.get("vmId"),
        "imageDigest": identity.get("imageDigest"),
        "installationId": identity.get("installationId"),
    }


def initialize_machine_identity(root: Path, *, accept_systemd_generated: bool = False) -> str:
    machine_id = root / "etc/machine-id"
    machine_id.parent.mkdir(parents=True, exist_ok=True)
    current = machine_id.read_text(encoding="utf-8").strip() if machine_id.exists() else ""
    if current:
        if not accept_systemd_generated:
            raise FirstBootError("machine_identity_not_clean")
        if not MACHINE_ID_RE.fullmatch(current):
            raise FirstBootError("machine_identity_invalid")
        value = current
    else:
        value = uuid.uuid4().hex
        machine_id.write_text(f"{value}\n", encoding="utf-8")

    dbus_machine_id = root / "var/lib/dbus/machine-id"
    dbus_machine_id.parent.mkdir(parents=True, exist_ok=True)
    if root != Path("/"):
        if dbus_machine_id.exists() or dbus_machine_id.is_symlink():
            dbus_machine_id.unlink()
        dbus_machine_id.symlink_to("../../../etc/machine-id")
    return value


def initialize_ssh_identity(root: Path, public_key: Any) -> None:
    ssh_dir = root / "etc/ssh"
    ssh_dir.mkdir(parents=True, exist_ok=True)
    existing = list(ssh_dir.glob("ssh_host_*_key"))
    if existing:
        raise FirstBootError("ssh_identity_not_clean")
    if root == Path("/"):
        run_checked(["ssh-keygen", "-A"], "ssh_identity_generation_failed")
    else:
        key_path = ssh_dir / "ssh_host_ed25519_key"
        run_checked(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key_path)], "ssh_identity_generation_failed")

    if public_key is not None:
        if not isinstance(public_key, str) or not public_key.startswith("ssh-") or "\n" in public_key:
            raise FirstBootError("operator_ssh_key_invalid")
        authorized = root / "var/lib/ravi/.ssh/authorized_keys"
        authorized.parent.mkdir(parents=True, exist_ok=True)
        authorized.write_text(f"{public_key.strip()}\n", encoding="utf-8")
        authorized.chmod(0o600)
        if root == Path("/"):
            subprocess.run(["chown", "-R", "ravi:ravi", str(authorized.parent)], check=True)


def provider_broker_base_url(payload: dict[str, Any]) -> str:
    provider = payload.get("providerBroker")
    if (
        not isinstance(provider, dict)
        or provider.get("kind") != "host_responses_proxy"
        or provider.get("wireApi") != "responses"
        or not isinstance(provider.get("baseUrl"), str)
    ):
        raise FirstBootError("bootstrap_provider_broker_invalid")
    value = provider["baseUrl"]
    try:
        parsed = urllib.parse.urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname or "")
        port = parsed.port
    except (ValueError, TypeError) as error:
        raise FirstBootError("bootstrap_provider_broker_invalid") from error
    if (
        parsed.scheme != "http"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/v1"
        or parsed.query
        or parsed.fragment
        or port != 7443
        or address.version != 4
        or not str(address).startswith("172.30.")
        or int(address) % 4 != 1
    ):
        raise FirstBootError("bootstrap_provider_broker_invalid")
    return value


def initialize_codex_provider(root: Path, payload: dict[str, Any]) -> None:
    base_url = provider_broker_base_url(payload)
    codex_dir = root / "var/lib/ravi/.codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    config_path = codex_dir / "config.toml"
    config_path.write_text(
        "\n".join(
            [
                'model_provider = "ravi-managed-openai"',
                "",
                "[model_providers.ravi-managed-openai]",
                'name = "Ravi Managed OpenAI"',
                f'base_url = "{base_url}"',
                'wire_api = "responses"',
                "requires_openai_auth = false",
                "",
            ]
        ),
        encoding="utf-8",
    )
    config_path.chmod(0o600)
    parsed = urllib.parse.urlsplit(base_url)
    provider_path = root / "var/lib/ravi/provisioning/provider-broker.json"
    write_json(
        provider_path,
        {
            "schemaVersion": "ravi.managed-appliance.provider-broker/v1",
            "baseUrl": base_url,
            "healthUrl": f"{parsed.scheme}://{parsed.netloc}/health",
            "kind": "host_responses_proxy",
        },
        0o600,
    )
    if root == Path("/"):
        subprocess.run(
            ["chown", "-R", "ravi:ravi", str(codex_dir), str(provider_path)],
            check=True,
        )


def validate_codex_provider_state(root: Path, identity: dict[str, Any]) -> None:
    expected = identity.get("providerBrokerBaseUrl")
    provider = read_json(
        root / "var/lib/ravi/provisioning/provider-broker.json",
        "provider_broker_state_missing",
    )
    config_path = root / "var/lib/ravi/.codex/config.toml"
    if (
        not isinstance(expected, str)
        or provider.get("schemaVersion") != "ravi.managed-appliance.provider-broker/v1"
        or provider.get("baseUrl") != expected
        or not config_path.is_file()
        or f'base_url = "{expected}"' not in config_path.read_text(encoding="utf-8")
    ):
        raise FirstBootError("provider_broker_state_invalid")


def initialize_ravi(root: Path, payload: dict[str, Any]) -> dict[str, str]:
    ravi_bin = root / "opt/ravi/current/bin/ravi"
    if not ravi_bin.exists():
        raise FirstBootError("ravi_release_missing")
    if root != Path("/"):
        return {"contextId": "validation-only"}

    agent = payload["initialAgent"]
    workspace = Path("/srv/ravi/agents") / agent["id"]
    workspace.mkdir(parents=True, exist_ok=True)
    agents_md = workspace / "AGENTS.md"
    if not agents_md.exists():
        agents_md.write_text("# Managed Ravi\n\nThis agent is governed by Ravi Console.\n", encoding="utf-8")
    subprocess.run(["chown", "-R", "ravi:ravi", str(workspace)], check=True)

    base_env = {
        **os.environ,
        "HOME": "/var/lib/ravi",
        "RAVI_STATE_DIR": "/var/lib/ravi/.ravi",
        "RAVI_CREDENTIALS_PATH": "/var/lib/ravi/.ravi/credentials.json",
    }
    admin_context_key = f"rctx_{secrets.token_urlsafe(32)}"
    bootstrap_env = {**base_env, "RAVI_BOOTSTRAP_KEY": admin_context_key}
    bootstrap = run_as_ravi_json(
        [
            str(ravi_bin),
            "daemon",
            "init-admin-key",
            "--from-env",
            "--print-only",
            "--label",
            "managed-appliance-firstboot",
            "--json",
        ],
        bootstrap_env,
        "ravi_context_bootstrap_command_failed",
    )
    admin_context_id = bootstrap.get("contextId")
    if not isinstance(admin_context_id, str) or not admin_context_id:
        raise FirstBootError("ravi_context_bootstrap_id_invalid")

    admin_env = {**base_env, "RAVI_CONTEXT_KEY": admin_context_key}
    controller: dict[str, Any] | None = None
    try:
        create = [
            str(ravi_bin),
            "agents",
            "create",
            agent["id"],
            str(workspace),
            "--provider",
            "codex",
            "--allow-runtime-mismatch",
            "--json",
        ]
        if agent.get("model"):
            create.extend(["--model", agent["model"]])
        run_as_ravi_json(create, admin_env, "ravi_initial_agent_failed")

        controller_spec = payload["controller"]
        controller = run_as_ravi_json(
            [
                str(ravi_bin),
                "context",
                "issue",
                controller_spec["label"],
                "--allow",
                ",".join(controller_spec["capabilities"]),
                "--ttl",
                format_cli_duration(controller_spec["ttlSeconds"]),
                "--json",
            ],
            admin_env,
            "ravi_controller_context_failed",
        )
    finally:
        run_as_ravi_json(
            [str(ravi_bin), "context", "revoke", admin_context_id, "--no-cascade", "--reason", "firstboot_complete", "--json"],
            admin_env,
            "ravi_bootstrap_context_revoke_failed",
        )

    if not isinstance(controller, dict):
        raise FirstBootError("ravi_controller_context_failed")
    controller_key = controller.get("contextKey")
    controller_id = controller.get("contextId")
    if not isinstance(controller_key, str) or not controller_key.startswith("rctx_"):
        raise FirstBootError("ravi_controller_context_failed")
    if not isinstance(controller_id, str) or not controller_id:
        raise FirstBootError("ravi_controller_context_failed")

    persist_controller_credential(root, payload, controller)
    return {"contextId": controller_id}


def persist_controller_credential(root: Path, payload: dict[str, Any], controller: dict[str, Any]) -> None:
    provisioning_dir = root / "var/lib/ravi/provisioning"
    credential_path = provisioning_dir / "controller-credential.json"
    claim_path = provisioning_dir / "controller-claim.json"
    state_path = provisioning_dir / "controller-state.json"
    write_json(
        credential_path,
        {
            "schemaVersion": "ravi.managed-appliance.controller-credential/v1",
            "contextId": controller["contextId"],
            "contextKey": controller["contextKey"],
            "expiresAt": normalize_context_expiry(controller.get("expiresAt")),
            "instanceId": payload["bindings"]["instanceId"],
        },
        0o600,
    )
    write_json(
        claim_path,
        {
            "schemaVersion": "ravi.managed-appliance.controller-claim/v1",
            "credentialClaimTokenHash": payload["controller"]["credentialClaimTokenHash"],
            "expiresAt": payload["expiresAt"],
            "instanceId": payload["bindings"]["instanceId"],
        },
        0o600,
    )
    write_json(
        state_path,
        {
            "schemaVersion": "ravi.managed-appliance.controller-state/v1",
            "currentContextId": controller["contextId"],
            "generation": 1,
            "updatedAt": format_time(dt.datetime.now(dt.timezone.utc)),
        },
        0o600,
    )
    if root == Path("/"):
        subprocess.run(
            ["chown", "ravi:ravi", str(credential_path), str(claim_path), str(state_path)],
            check=True,
        )


def run_as_ravi_json(command: list[str], env: dict[str, str], code: str) -> dict[str, Any]:
    safe_env = [
        f"{key}={value}"
        for key, value in env.items()
        if key
        in {
            "HOME",
            "PATH",
            "RAVI_STATE_DIR",
            "RAVI_BOOTSTRAP_KEY",
            "RAVI_CONTEXT_KEY",
            "RAVI_CREDENTIALS_PATH",
        }
    ]
    result = subprocess.run(
        ["runuser", "-u", "ravi", "--", "env", *safe_env, *command],
        capture_output=True,
        text=True,
        check=False,
        cwd="/",
    )
    if result.returncode != 0:
        try:
            failure = parse_json_object(result.stdout, code)
            reason = failure.get("reason") if isinstance(failure, dict) else None
        except FirstBootError:
            reason = None
        if isinstance(reason, str) and re.fullmatch(r"[a-z][a-z0-9_]{1,80}", reason):
            raise FirstBootError(f"{code}_{reason}")
        raise FirstBootError(code)

    return parse_json_object(result.stdout, code)


def parse_json_object(stdout: str, code: str) -> dict[str, Any]:
    try:
        value = json.loads(stdout.strip())
    except json.JSONDecodeError as error:
        raise FirstBootError(code) from error
    if not isinstance(value, dict):
        raise FirstBootError(code)
    return value


def format_cli_duration(seconds: int) -> str:
    if seconds % 86_400 == 0:
        return f"{seconds // 86_400}d"
    if seconds % 3_600 == 0:
        return f"{seconds // 3_600}h"
    if seconds % 60 == 0:
        return f"{seconds // 60}m"
    raise FirstBootError("ravi_controller_ttl_invalid")


def ensure_runtime_directories(root: Path) -> None:
    for relative, mode in (
        ("var/lib/ravi", 0o700),
        ("var/lib/ravi/.ravi", 0o700),
        ("var/lib/ravi/.codex", 0o700),
        ("var/lib/ravi/jetstream", 0o700),
        ("var/lib/ravi/provisioning", 0o700),
        ("var/lib/ravi/workspaces/agents", 0o750),
        ("srv/ravi", 0o750),
        ("var/log/ravi", 0o750),
        ("run/ravi", 0o750),
    ):
        path = root / relative
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(mode)
    if root == Path("/"):
        subprocess.run(["chown", "-R", "ravi:ravi", "/var/lib/ravi", "/srv/ravi", "/var/log/ravi", "/run/ravi"], check=True)


def ensure_volatile_runtime_directories(root: Path) -> None:
    runtime = root / "run/ravi"
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o750)
    if root == Path("/"):
        subprocess.run(["chown", "ravi:ravi", "/run/ravi"], check=True)


def erase_bootstrap_inputs(*paths: Path) -> None:
    for path in paths:
        if not path.is_file():
            continue
        try:
            path.write_bytes(secrets.token_bytes(min(max(path.stat().st_size, 1), 4096)))
        except OSError:
            pass
        try:
            path.unlink()
        except OSError as error:
            raise FirstBootError("bootstrap_erase_failed") from error


def write_failure(root: Path, code: str) -> None:
    try:
        write_json(
            root / "var/lib/ravi/provisioning/status.json",
            {"ready": False, "phase": "failed", "code": code, "updatedAt": format_time(dt.datetime.now(dt.timezone.utc))},
            0o600,
        )
    except OSError:
        pass


def rooted(root: Path, value: str) -> Path:
    return root / value.lstrip("/")


def read_json(path: Path, code: str) -> dict[str, Any]:
    require_file(path, code)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FirstBootError(code) from error
    if not isinstance(value, dict):
        raise FirstBootError(code)
    return value


def write_json(path: Path, value: Any, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(f"{json.dumps(value, sort_keys=True, separators=(',', ':'))}\n", encoding="utf-8")
    temporary.chmod(mode)
    temporary.replace(path)


def require_file(path: Path, code: str) -> None:
    if not path.is_file():
        raise FirstBootError(code)


def require_string(value: dict[str, Any], key: str, code: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise FirstBootError(code)
    return item


def parse_time(value: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise FirstBootError("bootstrap_time_invalid") from error
    if parsed.tzinfo is None:
        raise FirstBootError("bootstrap_time_invalid")
    return parsed.astimezone(dt.timezone.utc)


def normalize_context_expiry(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise FirstBootError("ravi_controller_context_failed")
    if isinstance(value, (int, float)):
        try:
            parsed = dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc)
        except (OverflowError, OSError, ValueError) as error:
            raise FirstBootError("ravi_controller_context_failed") from error
        return format_time(parsed)
    if isinstance(value, str):
        return format_time(parse_time(value))
    raise FirstBootError("ravi_controller_context_failed")


def format_time(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def run_checked(command: list[str], code: str) -> None:
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode != 0:
        raise FirstBootError(code)


if __name__ == "__main__":
    main()

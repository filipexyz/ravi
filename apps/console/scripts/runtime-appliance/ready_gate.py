#!/usr/bin/env python3
"""Private host-observable readiness gate for a Managed Ravi appliance."""

from __future__ import annotations

import base64
import binascii
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


READINESS_PATH = Path("/run/ravi/readiness.json")
CONTROLLER_CREDENTIAL_PATH = Path("/var/lib/ravi/provisioning/controller-credential.json")
CONTROLLER_CLAIM_PATH = Path("/var/lib/ravi/provisioning/controller-claim.json")
CONTROLLER_STATE_PATH = Path("/var/lib/ravi/provisioning/controller-state.json")
CONTROLLER_ROTATION_PENDING_PATH = Path(
    "/var/lib/ravi/provisioning/controller-rotation-pending.json"
)
CONTROLLER_ROTATION_CONSUMED_DIR = Path(
    "/var/lib/ravi/provisioning/controller-rotations-consumed"
)
IDENTITY_PATH = Path("/var/lib/ravi/identity.json")
BOOTSTRAP_PUBLIC_KEY_PATH = Path("/etc/ravi-appliance/bootstrap-public.pem")
RAVI_BIN = Path("/opt/ravi/current/bin/ravi")
READY_PORT = 4212
CLAIM_LOCK = threading.Lock()
ROTATION_LOCK = threading.Lock()
DIGEST_RE = re.compile(r"^sha256:[a-f0-9]{64}$")
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{1,239}$")
ROTATION_SCHEMA = "ravi.managed-appliance.controller-rotation/v1"
ROTATION_STATE_SCHEMA = "ravi.managed-appliance.controller-rotation-state/v1"
MAX_ROTATION_PAYLOAD_BYTES = 64 * 1024
MAX_ROTATION_REQUEST_BYTES = 96 * 1024
MAX_ROTATION_SIGNATURE_BYTES = 512
ROTATION_CLAIM_TTL = dt.timedelta(hours=1)
SAFE_CHECK_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")


class ControllerClaimError(RuntimeError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


def readiness_payload(path: Path = READINESS_PATH) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"code": "readiness_pending", "ok": False, "ready": False}
    ready = isinstance(value, dict) and value.get("ready") is True
    if ready:
        return {"ok": True, "ready": True}
    if not isinstance(value, dict):
        return {"code": "readiness_invalid", "ok": False, "ready": False}
    checks = value.get("checks")
    failed_checks = sorted(
        name
        for name, result in checks.items()
        if isinstance(checks, dict)
        and isinstance(name, str)
        and SAFE_CHECK_RE.fullmatch(name)
        and isinstance(result, dict)
        and result.get("ok") is False
    ) if isinstance(checks, dict) else []
    code = value.get("code")
    result: dict[str, Any] = {
        "code": code if code in {"readiness_failed", "readiness_pending"} else "readiness_invalid",
        "failedChecks": failed_checks[:32],
        "ok": False,
        "ready": False,
    }
    current_check = value.get("currentCheck")
    if isinstance(current_check, str) and SAFE_CHECK_RE.fullmatch(current_check):
        result["currentCheck"] = current_check
    return result


def claim_controller_credential(
    token: str,
    *,
    readiness_path: Path = READINESS_PATH,
    credential_path: Path = CONTROLLER_CREDENTIAL_PATH,
    claim_path: Path = CONTROLLER_CLAIM_PATH,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    if not token or len(token) > 256:
        raise ControllerClaimError(401, "controller_claim_unauthorized")
    if not readiness_payload(readiness_path)["ready"]:
        raise ControllerClaimError(503, "controller_not_ready")

    current_time = now or dt.datetime.now(dt.timezone.utc)
    with CLAIM_LOCK:
        if not claim_path.is_file() or not credential_path.is_file():
            raise ControllerClaimError(410, "controller_claim_consumed")
        claim = read_json_object(claim_path)
        expected_hash = claim.get("credentialClaimTokenHash")
        expires_at = parse_time(claim.get("expiresAt"))
        if (
            claim.get("schemaVersion") != "ravi.managed-appliance.controller-claim/v1"
            or not isinstance(expected_hash, str)
            or not DIGEST_RE.fullmatch(expected_hash)
            or not isinstance(claim.get("instanceId"), str)
        ):
            raise ControllerClaimError(503, "controller_claim_invalid")
        if expires_at <= current_time:
            remove_claim_files(credential_path, claim_path)
            raise ControllerClaimError(410, "controller_claim_expired")

        actual_hash = f"sha256:{hashlib.sha256(token.encode('utf-8')).hexdigest()}"
        if not hmac.compare_digest(actual_hash, expected_hash):
            raise ControllerClaimError(401, "controller_claim_unauthorized")

        credential = read_json_object(credential_path)
        if (
            credential.get("schemaVersion") != "ravi.managed-appliance.controller-credential/v1"
            or not isinstance(credential.get("contextId"), str)
            or not isinstance(credential.get("contextKey"), str)
            or not credential["contextKey"].startswith("rctx_")
            or credential.get("instanceId") != claim["instanceId"]
        ):
            raise ControllerClaimError(503, "controller_credential_invalid")

        remove_claim_files(credential_path, claim_path)
        return credential


def prepare_controller_rotation(
    payload_base64: str,
    signature_base64: str,
    *,
    now: dt.datetime | None = None,
    identity_path: Path = IDENTITY_PATH,
    controller_state_path: Path = CONTROLLER_STATE_PATH,
    public_key_path: Path = BOOTSTRAP_PUBLIC_KEY_PATH,
    pending_path: Path = CONTROLLER_ROTATION_PENDING_PATH,
    consumed_dir: Path = CONTROLLER_ROTATION_CONSUMED_DIR,
    signature_verifier: Any = None,
    rotation_executor: Any = None,
) -> dict[str, Any]:
    payload_bytes = decode_rotation_value(
        payload_base64,
        MAX_ROTATION_PAYLOAD_BYTES,
        "controller_rotation_payload_invalid",
    )
    signature = decode_rotation_value(
        signature_base64,
        MAX_ROTATION_SIGNATURE_BYTES,
        "controller_rotation_signature_invalid",
    )
    try:
        payload = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ControllerClaimError(400, "controller_rotation_payload_invalid") from error
    if not isinstance(payload, dict):
        raise ControllerClaimError(400, "controller_rotation_payload_invalid")

    verifier = signature_verifier or verify_rotation_signature
    if not verifier(payload_bytes, signature, public_key_path, pending_path.parent):
        raise ControllerClaimError(401, "controller_rotation_signature_invalid")

    current_time = now or dt.datetime.now(dt.timezone.utc)
    identity = read_json_object(identity_path)
    controller_state = read_json_object(controller_state_path)
    validate_rotation_payload(payload, identity, controller_state, current_time)
    grant_id = payload["grantId"]
    consumed_path = consumed_dir / f"{grant_id}.json"

    with ROTATION_LOCK:
        if consumed_path.is_file():
            raise ControllerClaimError(410, "controller_rotation_consumed")
        existing = read_optional_json_object(pending_path)
        if (
            existing
            and existing.get("grantId") != grant_id
            and discardable_authorized_rotation(
                existing,
                payload["bindings"]["instanceId"],
                current_time,
            )
        ):
            pending_path.unlink(missing_ok=True)
            existing = None
        if existing:
            if existing.get("grantId") != grant_id:
                raise ControllerClaimError(409, "controller_rotation_pending")
            if existing.get("phase") in {"claimable", "claimed"}:
                validate_claimable_rotation(existing, payload)
                return safe_rotation_projection(existing)
            executor = rotation_executor or execute_ravi_controller_rotation
            try:
                completed = executor(existing, payload, pending_path)
            except ControllerClaimError:
                raise
            except Exception as error:
                raise ControllerClaimError(
                    503,
                    "controller_rotation_execution_failed",
                ) from error
            validate_claimable_rotation(completed, payload)
            write_private_json(pending_path, completed)
            return safe_rotation_projection(completed)

        pending = {
            "schemaVersion": ROTATION_STATE_SCHEMA,
            "grantId": grant_id,
            "operationId": payload["bindings"]["operationId"],
            "instanceId": payload["bindings"]["instanceId"],
            "previousContextId": payload["bindings"]["previousContextId"],
            "credentialClaimTokenHash": payload["controller"]["credentialClaimTokenHash"],
            "expiresAt": payload["expiresAt"],
            "claimExpiresAt": format_time(current_time + ROTATION_CLAIM_TTL),
            "phase": "authorized",
            "temporaryAdminContextKey": f"rctx_{secrets.token_urlsafe(32)}",
            "temporaryAdminContextId": None,
            "replacement": None,
        }
        write_private_json(pending_path, pending)
        executor = rotation_executor or execute_ravi_controller_rotation
        try:
            completed = executor(pending, payload, pending_path)
        except ControllerClaimError:
            raise
        except Exception as error:
            raise ControllerClaimError(
                503,
                "controller_rotation_execution_failed",
            ) from error
        validate_claimable_rotation(completed, payload)
        write_private_json(pending_path, completed)
        return safe_rotation_projection(completed)


def discardable_authorized_rotation(
    pending: dict[str, Any], instance_id: str, now: dt.datetime
) -> bool:
    if (
        pending.get("schemaVersion") != ROTATION_STATE_SCHEMA
        or pending.get("phase") != "authorized"
        or pending.get("instanceId") != instance_id
        or pending.get("temporaryAdminContextId") is not None
        or pending.get("replacement") is not None
        or not isinstance(pending.get("temporaryAdminContextKey"), str)
    ):
        return False
    try:
        expires_at = parse_time(pending.get("expiresAt"))
        claim_expires_at = parse_time(pending.get("claimExpiresAt"))
    except ControllerClaimError:
        return False
    return expires_at <= now and claim_expires_at <= now


def claim_controller_rotation(
    token: str,
    grant_id: str,
    *,
    now: dt.datetime | None = None,
    pending_path: Path = CONTROLLER_ROTATION_PENDING_PATH,
) -> dict[str, Any]:
    current_time = now or dt.datetime.now(dt.timezone.utc)
    with ROTATION_LOCK:
        pending = read_optional_json_object(pending_path)
        if not pending:
            raise ControllerClaimError(410, "controller_rotation_claim_consumed")
        validate_rotation_claim_authority(pending, token, grant_id, current_time)
        replacement = pending.get("replacement")
        if not isinstance(replacement, dict):
            raise ControllerClaimError(503, "controller_rotation_not_ready")
        pending["phase"] = "claimed"
        pending["claimedAt"] = format_time(current_time)
        write_private_json(pending_path, pending)
        return dict(replacement)


def ack_controller_rotation(
    token: str,
    grant_id: str,
    context_id: str,
    *,
    now: dt.datetime | None = None,
    controller_state_path: Path = CONTROLLER_STATE_PATH,
    pending_path: Path = CONTROLLER_ROTATION_PENDING_PATH,
    consumed_dir: Path = CONTROLLER_ROTATION_CONSUMED_DIR,
) -> dict[str, Any]:
    current_time = now or dt.datetime.now(dt.timezone.utc)
    with ROTATION_LOCK:
        pending = read_optional_json_object(pending_path)
        if not pending:
            consumed = read_optional_json_object(consumed_dir / f"{grant_id}.json")
            if consumed and consumed.get("contextId") == context_id:
                validate_rotation_claim_token(
                    token,
                    consumed.get("credentialClaimTokenHash"),
                )
                return {
                    "ok": True,
                    "acknowledged": True,
                    "grantId": grant_id,
                    "contextId": context_id,
                }
            raise ControllerClaimError(410, "controller_rotation_claim_consumed")
        validate_rotation_claim_authority(pending, token, grant_id, current_time)
        replacement = pending.get("replacement")
        if (
            not isinstance(replacement, dict)
            or replacement.get("contextId") != context_id
        ):
            raise ControllerClaimError(409, "controller_rotation_ack_invalid")
        state = read_json_object(controller_state_path)
        if (
            state.get("schemaVersion")
            != "ravi.managed-appliance.controller-state/v1"
            or state.get("currentContextId") != pending.get("previousContextId")
            or not isinstance(state.get("generation"), int)
        ):
            raise ControllerClaimError(409, "controller_rotation_state_conflict")
        write_private_json(
            controller_state_path,
            {
                "schemaVersion": "ravi.managed-appliance.controller-state/v1",
                "currentContextId": context_id,
                "generation": state["generation"] + 1,
                "updatedAt": format_time(current_time),
            },
        )
        consumed_dir.mkdir(parents=True, exist_ok=True)
        consumed_dir.chmod(0o700)
        write_private_json(
            consumed_dir / f"{grant_id}.json",
            {
                "schemaVersion": "ravi.managed-appliance.controller-rotation-consumed/v1",
                "acknowledgedAt": format_time(current_time),
                "contextId": context_id,
                "credentialClaimTokenHash": pending.get(
                    "credentialClaimTokenHash"
                ),
                "grantId": grant_id,
                "instanceId": pending.get("instanceId"),
            },
        )
        pending_path.unlink(missing_ok=True)
        return {
            "ok": True,
            "acknowledged": True,
            "grantId": grant_id,
            "contextId": context_id,
        }


def execute_ravi_controller_rotation(
    pending: dict[str, Any],
    payload: dict[str, Any],
    pending_path: Path,
) -> dict[str, Any]:
    admin_key = pending.get("temporaryAdminContextKey")
    if not isinstance(admin_key, str) or not admin_key.startswith("rctx_"):
        raise ControllerClaimError(503, "controller_rotation_admin_state_invalid")
    base_env = {
        **os.environ,
        "HOME": "/var/lib/ravi",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "RAVI_STATE_DIR": "/var/lib/ravi/.ravi",
        "RAVI_CREDENTIALS_PATH": "/var/lib/ravi/.ravi/credentials.json",
    }
    bootstrap_env = {**base_env, "RAVI_BOOTSTRAP_KEY": admin_key}
    bootstrap = run_ravi_json(
        [
            str(RAVI_BIN),
            "daemon",
            "init-admin-key",
            "--from-env",
            "--print-only",
            "--label",
            f"managed-controller-rotation-{payload['grantId']}",
            "--json",
        ],
        bootstrap_env,
        "controller_rotation_admin_import_failed",
    )
    admin_context_id = bootstrap.get("contextId")
    if not isinstance(admin_context_id, str) or not admin_context_id:
        raise ControllerClaimError(503, "controller_rotation_admin_import_failed")
    pending["temporaryAdminContextId"] = admin_context_id
    pending["phase"] = "admin_ready"
    write_private_json(pending_path, pending)
    admin_env = {**base_env, "RAVI_CONTEXT_KEY": admin_key}

    replacement = pending.get("replacement")
    issued_for = f"{payload['controller']['label']}-{payload['grantId']}"
    if not isinstance(replacement, dict):
        for context in list_ravi_contexts(admin_env):
            if (
                context.get("status") == "active"
                and context.get("issuedFor") == issued_for
            ):
                revoke_ravi_context(
                    context.get("contextId"),
                    admin_env,
                    "rotation_orphan_cleanup",
                )
        replacement = run_ravi_json(
            [
                str(RAVI_BIN),
                "context",
                "issue",
                issued_for,
                "--allow",
                ",".join(payload["controller"]["capabilities"]),
                "--ttl",
                format_cli_duration(payload["controller"]["ttlSeconds"]),
                "--json",
            ],
            admin_env,
            "controller_rotation_issue_failed",
        )
        validate_replacement_credential(replacement, pending["instanceId"])
        pending["replacement"] = {
            "schemaVersion": "ravi.managed-appliance.controller-credential/v1",
            "contextId": replacement["contextId"],
            "contextKey": replacement["contextKey"],
            "expiresAt": normalize_context_expiry(replacement.get("expiresAt")),
            "instanceId": pending["instanceId"],
        }
        pending["phase"] = "replacement_issued"
        write_private_json(pending_path, pending)

    contexts = list_ravi_contexts(admin_env)
    if context_is_active(contexts, pending["previousContextId"]):
        revoke_ravi_context(
            pending["previousContextId"],
            admin_env,
            "managed_controller_rotation",
        )
    pending["phase"] = "previous_revoked"
    write_private_json(pending_path, pending)

    contexts = list_ravi_contexts(admin_env)
    if context_is_active(contexts, admin_context_id):
        revoke_ravi_context(
            admin_context_id,
            admin_env,
            "managed_controller_rotation_complete",
        )
    pending.pop("temporaryAdminContextKey", None)
    pending["phase"] = "claimable"
    write_private_json(pending_path, pending)
    return pending


def validate_rotation_payload(
    payload: dict[str, Any],
    identity: dict[str, Any],
    controller_state: dict[str, Any],
    now: dt.datetime,
) -> None:
    if payload.get("schemaVersion") != ROTATION_SCHEMA:
        raise ControllerClaimError(400, "controller_rotation_schema_invalid")
    grant_id = payload.get("grantId")
    try:
        uuid.UUID(str(grant_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise ControllerClaimError(400, "controller_rotation_grant_invalid") from error
    issued_at = parse_time(payload.get("issuedAt"))
    expires_at = parse_time(payload.get("expiresAt"))
    if issued_at > now + dt.timedelta(seconds=30):
        raise ControllerClaimError(409, "controller_rotation_not_yet_valid")
    if expires_at <= now:
        raise ControllerClaimError(410, "controller_rotation_expired")
    if expires_at <= issued_at or expires_at - issued_at > dt.timedelta(minutes=5):
        raise ControllerClaimError(400, "controller_rotation_ttl_invalid")
    bindings = payload.get("bindings")
    if not isinstance(bindings, dict):
        raise ControllerClaimError(400, "controller_rotation_bindings_invalid")
    for key in ["operationId", "hostId", "vmId", "instanceId", "deckInstanceRef", "imageDigest", "previousContextId"]:
        if not isinstance(bindings.get(key), str) or not SAFE_ID_RE.fullmatch(bindings[key]):
            raise ControllerClaimError(400, "controller_rotation_bindings_invalid")
    expected = {
        "hostId": identity.get("hostId"),
        "vmId": identity.get("vmId"),
        "instanceId": identity.get("instanceId"),
        "deckInstanceRef": identity.get("deckInstanceRef"),
        "imageDigest": identity.get("imageDigest"),
        "previousContextId": controller_state.get("currentContextId"),
    }
    if any(bindings.get(key) != value for key, value in expected.items()):
        raise ControllerClaimError(409, "controller_rotation_binding_mismatch")
    if bindings["deckInstanceRef"] != f"managed-{bindings['instanceId']}":
        raise ControllerClaimError(409, "controller_rotation_deck_binding_invalid")
    if (
        controller_state.get("schemaVersion")
        != "ravi.managed-appliance.controller-state/v1"
        or not isinstance(controller_state.get("generation"), int)
    ):
        raise ControllerClaimError(409, "controller_rotation_state_invalid")
    controller = payload.get("controller")
    if (
        not isinstance(controller, dict)
        or not isinstance(controller.get("label"), str)
        or not isinstance(controller.get("credentialClaimTokenHash"), str)
        or not DIGEST_RE.fullmatch(controller["credentialClaimTokenHash"])
        or not isinstance(controller.get("capabilities"), list)
        or not 1 <= len(controller["capabilities"]) <= 32
        or not all(isinstance(item, str) and 1 <= len(item) <= 200 for item in controller["capabilities"])
        or not isinstance(controller.get("ttlSeconds"), int)
        or controller["ttlSeconds"] < 300
        or controller["ttlSeconds"] > 90 * 24 * 60 * 60
        or controller["ttlSeconds"] % 60 != 0
    ):
        raise ControllerClaimError(400, "controller_rotation_policy_invalid")


def validate_claimable_rotation(
    pending: dict[str, Any], payload: dict[str, Any]
) -> None:
    if (
        pending.get("schemaVersion") != ROTATION_STATE_SCHEMA
        or pending.get("grantId") != payload.get("grantId")
        or pending.get("phase") not in {"claimable", "claimed"}
        or not isinstance(pending.get("replacement"), dict)
    ):
        raise ControllerClaimError(503, "controller_rotation_execution_failed")
    validate_replacement_credential(pending["replacement"], pending.get("instanceId"))
    if pending["replacement"].get("contextId") == pending.get("previousContextId"):
        raise ControllerClaimError(503, "controller_rotation_replacement_invalid")


def validate_replacement_credential(value: dict[str, Any], instance_id: Any) -> None:
    if (
        not isinstance(value.get("contextId"), str)
        or not isinstance(value.get("contextKey"), str)
        or not value["contextKey"].startswith("rctx_")
        or not isinstance(instance_id, str)
    ):
        raise ControllerClaimError(503, "controller_rotation_replacement_invalid")


def validate_rotation_claim_authority(
    pending: dict[str, Any],
    token: str,
    grant_id: str,
    now: dt.datetime,
) -> None:
    if (
        pending.get("schemaVersion") != ROTATION_STATE_SCHEMA
        or pending.get("grantId") != grant_id
        or pending.get("phase") not in {"claimable", "claimed"}
    ):
        raise ControllerClaimError(409, "controller_rotation_claim_invalid")
    expires_at = parse_time(pending.get("claimExpiresAt"))
    if expires_at <= now:
        raise ControllerClaimError(410, "controller_rotation_claim_expired")
    validate_rotation_claim_token(
        token,
        pending.get("credentialClaimTokenHash"),
    )


def validate_rotation_claim_token(token: str, expected_hash: Any) -> None:
    if not token or len(token) > 256 or any(character.isspace() for character in token):
        raise ControllerClaimError(401, "controller_rotation_claim_unauthorized")
    actual_hash = f"sha256:{hashlib.sha256(token.encode('utf-8')).hexdigest()}"
    if (
        not isinstance(expected_hash, str)
        or not DIGEST_RE.fullmatch(expected_hash)
        or not hmac.compare_digest(actual_hash, expected_hash)
    ):
        raise ControllerClaimError(401, "controller_rotation_claim_unauthorized")


def safe_rotation_projection(pending: dict[str, Any]) -> dict[str, Any]:
    replacement = pending.get("replacement")
    return {
        "ok": pending.get("phase") in {"claimable", "claimed"},
        "grantId": pending.get("grantId"),
        "phase": pending.get("phase"),
        "replacementContextId": replacement.get("contextId") if isinstance(replacement, dict) else None,
    }


def read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ControllerClaimError(503, "controller_claim_invalid") from error
    if not isinstance(value, dict):
        raise ControllerClaimError(503, "controller_claim_invalid")
    return value


def read_optional_json_object(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return read_json_object(path)


def decode_rotation_value(value: Any, maximum: int, code: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > maximum * 2:
        raise ControllerClaimError(400, code)
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ControllerClaimError(400, code) from error
    if not decoded or len(decoded) > maximum:
        raise ControllerClaimError(400, code)
    return decoded


def verify_rotation_signature(
    payload: bytes,
    signature: bytes,
    public_key_path: Path,
    work_dir: Path,
) -> bool:
    if not public_key_path.is_file():
        return False
    work_dir.mkdir(parents=True, exist_ok=True)
    payload_path = work_dir / f".rotation-payload-{uuid.uuid4().hex}"
    signature_path = work_dir / f".rotation-signature-{uuid.uuid4().hex}"
    try:
        payload_path.write_bytes(payload)
        signature_path.write_bytes(signature)
        payload_path.chmod(0o600)
        signature_path.chmod(0o600)
        result = subprocess.run(
            [
                "openssl",
                "pkeyutl",
                "-verify",
                "-pubin",
                "-inkey",
                str(public_key_path),
                "-rawin",
                "-in",
                str(payload_path),
                "-sigfile",
                str(signature_path),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        payload_path.unlink(missing_ok=True)
        signature_path.unlink(missing_ok=True)


def write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(
            f"{json.dumps(value, sort_keys=True, separators=(',', ':'))}\n",
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(path)
        path.chmod(0o600)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise ControllerClaimError(503, "controller_rotation_state_write_failed") from error


def run_ravi_json(
    command: list[str], env: dict[str, str], code: str
) -> dict[str, Any]:
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
    try:
        result = subprocess.run(
            ["env", *safe_env, *command],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
            cwd="/",
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ControllerClaimError(503, code) from error
    if result.returncode != 0:
        raise ControllerClaimError(503, code)
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise ControllerClaimError(503, code) from error
    if not isinstance(value, dict):
        raise ControllerClaimError(503, code)
    return value


def list_ravi_contexts(env: dict[str, str]) -> list[dict[str, Any]]:
    value = run_ravi_json(
        [str(RAVI_BIN), "context", "list", "--all", "--limit", "500", "--json"],
        env,
        "controller_rotation_context_list_failed",
    )
    contexts = value.get("contexts")
    if not isinstance(contexts, list) or not all(isinstance(item, dict) for item in contexts):
        raise ControllerClaimError(503, "controller_rotation_context_list_failed")
    return contexts


def context_is_active(contexts: list[dict[str, Any]], context_id: Any) -> bool:
    return isinstance(context_id, str) and any(
        item.get("contextId") == context_id and item.get("status") == "active"
        for item in contexts
    )


def revoke_ravi_context(context_id: Any, env: dict[str, str], reason: str) -> None:
    if not isinstance(context_id, str) or not context_id:
        raise ControllerClaimError(503, "controller_rotation_context_invalid")
    run_ravi_json(
        [
            str(RAVI_BIN),
            "context",
            "revoke",
            context_id,
            "--no-cascade",
            "--reason",
            reason,
            "--json",
        ],
        env,
        "controller_rotation_context_revoke_failed",
    )


def format_cli_duration(seconds: Any) -> str:
    if not isinstance(seconds, int) or seconds < 300 or seconds % 60 != 0:
        raise ControllerClaimError(400, "controller_rotation_policy_invalid")
    if seconds % 86_400 == 0:
        return f"{seconds // 86_400}d"
    if seconds % 3_600 == 0:
        return f"{seconds // 3_600}h"
    return f"{seconds // 60}m"


def format_time(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_context_expiry(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ControllerClaimError(503, "controller_rotation_replacement_invalid")
    if isinstance(value, (int, float)):
        try:
            parsed = dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc)
        except (OverflowError, OSError, ValueError) as error:
            raise ControllerClaimError(
                503, "controller_rotation_replacement_invalid"
            ) from error
        return format_time(parsed)
    if isinstance(value, str):
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ControllerClaimError(
                503, "controller_rotation_replacement_invalid"
            ) from error
        if parsed.tzinfo is None:
            raise ControllerClaimError(
                503, "controller_rotation_replacement_invalid"
            )
        return format_time(parsed)
    raise ControllerClaimError(503, "controller_rotation_replacement_invalid")


def parse_time(value: Any) -> dt.datetime:
    if not isinstance(value, str):
        raise ControllerClaimError(503, "controller_claim_invalid")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ControllerClaimError(503, "controller_claim_invalid") from error
    if parsed.tzinfo is None:
        raise ControllerClaimError(503, "controller_claim_invalid")
    return parsed.astimezone(dt.timezone.utc)


def remove_claim_files(*paths: Path) -> None:
    try:
        for path in paths:
            path.unlink(missing_ok=True)
    except OSError as error:
        raise ControllerClaimError(503, "controller_claim_cleanup_failed") from error


class ReadinessHandler(BaseHTTPRequestHandler):
    server_version = "RaviReadinessGate/1"

    def do_GET(self) -> None:  # noqa: N802
        self.respond_health(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self.respond_health(include_body=False)

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/controller/claim":
                token = bearer_token(self.headers.get("authorization"))
                credential = claim_controller_credential(token)
                self.send_json(200, {"ok": True, "credential": credential})
                return
            if self.path == "/controller/rotation/prepare":
                body = self.read_json_body()
                result = prepare_controller_rotation(
                    body.get("payloadBase64"),
                    body.get("signatureBase64"),
                )
                self.send_json(200, result)
                return
            if self.path == "/controller/rotation/claim":
                body = self.read_json_body()
                token = bearer_token(
                    self.headers.get("authorization"),
                    "controller_rotation_claim_unauthorized",
                )
                result = claim_controller_rotation(token, body.get("grantId"))
                self.send_json(200, {"ok": True, "credential": result})
                return
            if self.path == "/controller/rotation/ack":
                body = self.read_json_body()
                token = bearer_token(
                    self.headers.get("authorization"),
                    "controller_rotation_claim_unauthorized",
                )
                result = ack_controller_rotation(
                    token,
                    body.get("grantId"),
                    body.get("contextId"),
                )
                self.send_json(200, result)
                return
            self.send_json(404, {"ok": False, "code": "not_found"})
        except ControllerClaimError as error:
            self.send_json(error.status, {"ok": False, "code": error.code})

    def read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("content-length")
        try:
            content_length = int(raw_length) if raw_length is not None else -1
        except ValueError as error:
            raise ControllerClaimError(400, "request_body_invalid") from error
        if content_length <= 0 or content_length > MAX_ROTATION_REQUEST_BYTES:
            raise ControllerClaimError(400, "request_body_invalid")
        try:
            value = json.loads(self.rfile.read(content_length))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ControllerClaimError(400, "request_body_invalid") from error
        if not isinstance(value, dict):
            raise ControllerClaimError(400, "request_body_invalid")
        return value

    def respond_health(self, *, include_body: bool) -> None:
        if self.path != "/health":
            payload = {"ok": False, "ready": False}
            status = 404
        else:
            payload = readiness_payload()
            status = 200 if payload["ready"] else 503
        self.send_json(status, payload, include_body=include_body)

    def send_json(self, status: int, payload: dict[str, Any], *, include_body: bool = True) -> None:
        body = f"{json.dumps(payload, sort_keys=True, separators=(',', ':'))}\n".encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        if include_body:
            self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def bearer_token(
    value: str | None,
    code: str = "controller_claim_unauthorized",
) -> str:
    if not value or not value.startswith("Bearer "):
        raise ControllerClaimError(401, code)
    token = value[7:]
    if not token or len(token) > 256 or any(character.isspace() for character in token):
        raise ControllerClaimError(401, code)
    return token


def main() -> None:
    host = os.environ.get("RAVI_READY_HOST", "0.0.0.0")
    port = int(os.environ.get("RAVI_READY_PORT", str(READY_PORT)))
    server = ThreadingHTTPServer((host, port), ReadinessHandler)
    server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()

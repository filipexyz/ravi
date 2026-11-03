#!/usr/bin/env python3
"""Validate appliance inputs and emit safe provenance/SBOM documents."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
from typing import Any


CONTRACT_SCHEMA = "ravi.managed-appliance.image-contract/v1"


def main() -> None:
    parser = argparse.ArgumentParser(description="Managed Ravi appliance image metadata")
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate = subparsers.add_parser("validate-contract")
    add_contract_arguments(validate)

    emit = subparsers.add_parser("emit")
    add_contract_arguments(emit)
    emit.add_argument("--kernel", required=True)
    emit.add_argument("--rootfs", required=True)
    emit.add_argument("--base-squashfs", required=True)
    emit.add_argument("--ravi-release-sha256", required=True)
    emit.add_argument("--output-dir", required=True)

    args = parser.parse_args()
    contract = read_json(Path(args.contract))
    validate_contract(contract, args)
    if args.command == "validate-contract":
        print(json.dumps({"ok": True, "schemaVersion": contract["schemaVersion"]}, sort_keys=True))
        return
    emit_metadata(contract, args)


def add_contract_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--contract", required=True)
    parser.add_argument("--bootstrap-public-key", required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--ravi-version", required=True)
    parser.add_argument("--ravi-revision", required=True)
    parser.add_argument("--codex-version", required=True)
    parser.add_argument("--bun-version", required=True)
    parser.add_argument("--nats-version", required=True)


def validate_contract(contract: dict[str, Any], args: argparse.Namespace) -> None:
    expected = {
        "schemaVersion": CONTRACT_SCHEMA,
        "image.name": args.name,
        "runtime.provider": "codex",
        "storage.stateLabel": "RAVI_STATE",
        "storage.stateMount": "/var/lib/ravi",
        "storage.bootstrapLabel": "RAVI_BOOTSTRAP",
        "storage.bootstrapMount": "/run/ravi-bootstrap",
        "versions.ravi": args.ravi_version,
        "versions.raviRevision": args.ravi_revision,
        "versions.codex": args.codex_version,
        "versions.bun": args.bun_version,
        "versions.nats": args.nats_version,
        "materials.bootstrapPublicKey": sha256_file(Path(args.bootstrap_public_key)),
    }
    for path, value in expected.items():
        if nested(contract, path) != value:
            raise SystemExit(f"contract mismatch: {path}")
    digest = nested(contract, "image.digest")
    if not isinstance(digest, str) or not digest.startswith("sha256:") or len(digest) != 71:
        raise SystemExit("contract mismatch: image.digest")
    if not isinstance(nested(contract, "runtime.requireCodexAuth"), bool):
        raise SystemExit("contract mismatch: runtime.requireCodexAuth")


def emit_metadata(contract: dict[str, Any], args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    kernel = Path(args.kernel)
    rootfs = Path(args.rootfs)
    base = Path(args.base_squashfs)
    checksums = {
        "kernel": sha256_file(kernel),
        "rootfs": sha256_file(rootfs),
        "baseSquashfs": sha256_file(base),
        "contract": sha256_file(Path(args.contract)),
        "raviRelease": args.ravi_release_sha256,
    }
    built_at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    provenance = {
        "schemaVersion": "ravi.managed-appliance.provenance/v1",
        "builtAt": built_at,
        "builder": {"id": "ravi-console/runtime-appliance"},
        "subject": {
            "imageDigest": nested(contract, "image.digest"),
            "rootfs": {"name": rootfs.name, "sha256": checksums["rootfs"]},
            "kernel": {"name": kernel.name, "sha256": checksums["kernel"]},
        },
        "materials": {
            "baseSquashfsSha256": checksums["baseSquashfs"],
            "bootstrapPublicKeySha256": sha256_file(Path(args.bootstrap_public_key)),
            "contractSha256": checksums["contract"],
            "raviReleaseSha256": checksums["raviRelease"],
            "raviRevision": args.ravi_revision,
        },
        "versions": contract["versions"],
    }
    sbom = {
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": f"{args.name}-{checksums['rootfs'][:12]}",
        "documentNamespace": f"https://ravi.bot/spdx/{checksums['rootfs']}",
        "creationInfo": {"created": built_at, "creators": ["Tool: ravi-console/runtime-appliance"]},
        "packages": [
            spdx_package("Ravi", args.ravi_version, "SPDXRef-Package-Ravi", args.ravi_revision),
            spdx_package("Codex CLI", args.codex_version, "SPDXRef-Package-Codex"),
            spdx_package("Bun", args.bun_version, "SPDXRef-Package-Bun"),
            spdx_package("NATS Server", args.nats_version, "SPDXRef-Package-Nats"),
        ],
        "files": [
            spdx_file(rootfs.name, "SPDXRef-File-Rootfs", checksums["rootfs"]),
            spdx_file(kernel.name, "SPDXRef-File-Kernel", checksums["kernel"]),
        ],
    }
    write_json(output_dir / "provenance.json", provenance)
    write_json(output_dir / "sbom.spdx.json", sbom)
    print(json.dumps({"ok": True, "rootfsSha256": checksums["rootfs"]}, sort_keys=True))


def spdx_package(name: str, version: str, identifier: str, revision: str | None = None) -> dict[str, Any]:
    package = {
        "name": name,
        "SPDXID": identifier,
        "versionInfo": version,
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": False,
        "licenseConcluded": "NOASSERTION",
        "licenseDeclared": "NOASSERTION",
        "copyrightText": "NOASSERTION",
    }
    if revision:
        package["externalRefs"] = [
            {
                "referenceCategory": "OTHER",
                "referenceType": "vcs-revision",
                "referenceLocator": revision,
            }
        ]
    return package


def spdx_file(name: str, identifier: str, digest: str) -> dict[str, Any]:
    return {
        "fileName": name,
        "SPDXID": identifier,
        "checksums": [{"algorithm": "SHA256", "checksumValue": digest}],
        "licenseConcluded": "NOASSERTION",
        "copyrightText": "NOASSERTION",
    }


def nested(value: dict[str, Any], path: str) -> Any:
    current: Any = value
    for segment in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return current


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit("contract is not valid JSON") from error
    if not isinstance(value, dict):
        raise SystemExit("contract must be an object")
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.write_text(f"{json.dumps(value, indent=2, sort_keys=True)}\n", encoding="utf-8")
    path.chmod(0o644)


if __name__ == "__main__":
    main()

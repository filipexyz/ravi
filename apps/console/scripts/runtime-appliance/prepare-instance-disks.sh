#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo prepare-instance-disks.sh \
  --payload PATH --signature PATH --output-dir PATH \
  [--state-size-mib 8192] [--bootstrap-size-mib 32] [--owner UID:GID]
EOF
}

declare -A ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --payload|--signature|--output-dir|--state-size-mib|--bootstrap-size-mib|--owner)
      ARG["${1#--}"]="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for key in payload signature output-dir; do
  [[ -n ${ARG[$key]:-} ]] || { echo "Missing --$key" >&2; exit 2; }
done
[[ ${EUID} -eq 0 ]] || { echo "Run with sudo so guest ownership is deterministic." >&2; exit 2; }

state_size=${ARG[state-size-mib]:-8192}
bootstrap_size=${ARG[bootstrap-size-mib]:-32}
[[ "$state_size" =~ ^[0-9]+$ ]] && (( state_size >= 4096 )) || { echo "--state-size-mib must be >= 4096" >&2; exit 2; }
[[ "$bootstrap_size" =~ ^[0-9]+$ ]] && (( bootstrap_size >= 16 )) || { echo "--bootstrap-size-mib must be >= 16" >&2; exit 2; }

owner=${ARG[owner]:-${SUDO_UID:-0}:${SUDO_GID:-0}}
[[ "$owner" =~ ^[0-9]+:[0-9]+$ ]] || { echo "--owner must be UID:GID" >&2; exit 2; }
output_dir=$(realpath -m "${ARG[output-dir]}")
mkdir -p "$output_dir"

projection=$(python3 - "${ARG[payload]}" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    payload = json.load(handle)
bindings = payload.get("bindings", {})
for key in ("instanceId", "vmId", "imageDigest"):
    if not isinstance(bindings.get(key), str) or not bindings[key]:
        raise SystemExit(f"invalid payload binding: {key}")
if not re.fullmatch(r"[A-Za-z0-9._:-]{3,160}", bindings["instanceId"]):
    raise SystemExit("invalid payload binding: instanceId")
print(json.dumps({
    "instanceId": bindings["instanceId"],
    "vmId": bindings["vmId"],
    "imageDigest": bindings["imageDigest"],
}, separators=(",", ":")))
PY
)
instance_id=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["instanceId"])' "$projection")
slug=$(printf '%s' "$instance_id" | tr ':.' '--')

work=$(mktemp -d "$output_dir/.instance-disks.XXXXXX")
trap 'rm -rf "$work"' EXIT
state_staging="$work/state"
bootstrap_staging="$work/bootstrap"
mkdir -p "$state_staging/.ravi" "$state_staging/.codex" "$state_staging/jetstream" \
  "$state_staging/provisioning/consumed" "$state_staging/workspaces/agents" "$state_staging/logs" "$bootstrap_staging"
python3 - "$projection" "$state_staging/.ravi-state-volume.json" <<'PY'
import json
import sys

projection = json.loads(sys.argv[1])
projection["schemaVersion"] = "ravi.managed-appliance.state-volume/v1"
with open(sys.argv[2], "w", encoding="utf-8") as handle:
    json.dump(projection, handle, sort_keys=True, separators=(",", ":"))
    handle.write("\n")
PY
chown -R 62000:62000 "$state_staging"
chmod 0700 "$state_staging" "$state_staging/.ravi" "$state_staging/.codex" "$state_staging/jetstream" "$state_staging/provisioning"

install -m 0600 "${ARG[payload]}" "$bootstrap_staging/payload.json"
install -m 0600 "${ARG[signature]}" "$bootstrap_staging/payload.sig"

state_disk="$output_dir/${slug}.state.ext4"
bootstrap_disk="$output_dir/${slug}.bootstrap.ext4"
rm -f "$state_disk" "$bootstrap_disk"
truncate -s "${state_size}M" "$state_disk"
truncate -s "${bootstrap_size}M" "$bootstrap_disk"
mkfs.ext4 -q -F -L RAVI_STATE -d "$state_staging" "$state_disk"
mkfs.ext4 -q -F -L RAVI_BOOTSTRAP -d "$bootstrap_staging" "$bootstrap_disk"
e2fsck -fn "$state_disk" >/dev/null
e2fsck -fn "$bootstrap_disk" >/dev/null
chown "$owner" "$state_disk" "$bootstrap_disk"
chmod 0600 "$state_disk" "$bootstrap_disk"

state_sha=$(sha256sum "$state_disk" | awk '{print $1}')
bootstrap_sha=$(sha256sum "$bootstrap_disk" | awk '{print $1}')
manifest="$output_dir/${slug}.disks.json"
python3 - "$projection" "$state_disk" "$state_sha" "$state_size" "$bootstrap_disk" "$bootstrap_sha" "$bootstrap_size" "$manifest" <<'PY'
import json
import os
import sys

projection = json.loads(sys.argv[1])
value = {
    "schemaVersion": "ravi.managed-appliance.instance-disks/v1",
    **projection,
    "state": {"path": os.path.basename(sys.argv[2]), "sha256": sys.argv[3], "sizeMib": int(sys.argv[4]), "label": "RAVI_STATE"},
    "bootstrap": {"path": os.path.basename(sys.argv[5]), "sha256": sys.argv[6], "sizeMib": int(sys.argv[7]), "label": "RAVI_BOOTSTRAP"},
}
with open(sys.argv[8], "w", encoding="utf-8") as handle:
    json.dump(value, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
chown "$owner" "$manifest"
chmod 0644 "$manifest"
echo "$manifest"

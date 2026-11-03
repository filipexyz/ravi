#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: sudo build-rootfs.sh \
  --name NAME --base-squashfs PATH --kernel PATH --ravi-release PATH \
  --ravi-version VERSION --ravi-revision SHA --bun-bin PATH --bun-version VERSION \
  --nats-bin PATH --nats-version VERSION --codex-dir PATH --codex-version VERSION \
  --bootstrap-public-key PATH --contract PATH --output-dir PATH [--size-mib 12288]
EOF
}

declare -A ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --size-mib) ARG[size_mib]="$2"; shift 2 ;;
    --name|--base-squashfs|--kernel|--ravi-release|--ravi-version|--ravi-revision|--bun-bin|--bun-version|--nats-bin|--nats-version|--codex-dir|--codex-version|--bootstrap-public-key|--contract|--output-dir)
      ARG["${1#--}"]="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

required=(name base-squashfs kernel ravi-release ravi-version ravi-revision bun-bin bun-version nats-bin nats-version codex-dir codex-version bootstrap-public-key contract output-dir)
for key in "${required[@]}"; do
  normalized=${key//-/_}
  value=${ARG[$key]:-${ARG[$normalized]:-}}
  [[ -n "$value" ]] || { echo "Missing --${key}" >&2; exit 2; }
  ARG[$normalized]="$value"
done
[[ ${EUID} -eq 0 ]] || { echo "Run with sudo so rootfs ownership is deterministic." >&2; exit 2; }

size_mib=${ARG[size_mib]:-12288}
[[ "$size_mib" =~ ^[0-9]+$ ]] && (( size_mib >= 8192 )) || { echo "--size-mib must be >= 8192" >&2; exit 2; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 "$script_dir/image_metadata.py" validate-contract \
  --contract "${ARG[contract]}" --name "${ARG[name]}" \
  --bootstrap-public-key "${ARG[bootstrap_public_key]}" \
  --ravi-version "${ARG[ravi_version]}" --ravi-revision "${ARG[ravi_revision]}" \
  --codex-version "${ARG[codex_version]}" --bun-version "${ARG[bun_version]}" --nats-version "${ARG[nats_version]}" >/dev/null
output_dir=$(realpath -m "${ARG[output_dir]}")
staging="$output_dir/rootfs"
rootfs="$output_dir/${ARG[name]}.ext4"
manifest="$output_dir/${ARG[name]}.manifest.json"
rm -rf "$staging"
mkdir -p "$output_dir"

unsquashfs -f -d "$staging" "${ARG[base_squashfs]}" >/dev/null

chroot "$staging" /usr/sbin/groupadd --system --gid 62000 ravi 2>/dev/null || true
chroot "$staging" /usr/sbin/useradd --system --uid 62000 --gid 62000 --home-dir /var/lib/ravi --shell /bin/bash --password '*' ravi 2>/dev/null || true
chroot "$staging" /usr/sbin/usermod --shell /bin/bash --password '*' ravi

# A previous appliance image is a valid build base, but its immutable runtime
# layers are not. Replace them so readiness and provenance describe one release.
rm -rf "$staging/opt/ravi/releases" "$staging/opt/ravi/current" "$staging/opt/codex"
release_dir="$staging/opt/ravi/releases/${ARG[ravi_version]}"
mkdir -p "$release_dir" "$staging/opt/codex" "$staging/etc/ravi-appliance" "$staging/usr/lib/ravi-appliance"
cp -a "${ARG[ravi_release]}/." "$release_dir/"
ln -sfn "releases/${ARG[ravi_version]}" "$staging/opt/ravi/current"
cp -a "${ARG[codex_dir]}/." "$staging/opt/codex/"
# Package trees are runtime artifacts. Some generated SDKs import modules named
# `tests`, so only source maps and repository metadata are safe to prune here.
find "$release_dir" "$staging/opt/codex" -type f -name '*.map' -delete
find "$release_dir" "$staging/opt/codex" -depth -type d -name .github -exec rm -rf {} +
chown -R 0:0 "$release_dir" "$staging/opt/codex"
install -m 0755 "${ARG[bun_bin]}" "$staging/usr/local/bin/bun"
install -m 0755 "${ARG[nats_bin]}" "$staging/usr/local/bin/nats-server"
cat >"$staging/usr/local/bin/codex" <<'EOF'
#!/bin/sh
exec /usr/local/bin/bun /opt/codex/node_modules/@openai/codex/bin/codex.js "$@"
EOF
chmod 0755 "$staging/usr/local/bin/codex"
install -m 0755 "$script_dir/firstboot.py" "$staging/usr/lib/ravi-appliance/firstboot.py"
install -m 0755 "$script_dir/network.py" "$staging/usr/lib/ravi-appliance/network.py"
install -m 0755 "$script_dir/readiness.py" "$staging/usr/lib/ravi-appliance/readiness.py"
install -m 0755 "$script_dir/ready_gate.py" "$staging/usr/lib/ravi-appliance/ready_gate.py"
install -m 0644 "${ARG[bootstrap_public_key]}" "$staging/etc/ravi-appliance/bootstrap-public.pem"
install -m 0644 "${ARG[contract]}" "$staging/etc/ravi-appliance/contract.json"

mkdir -p "$staging/var/lib/ravi" "$staging/srv/ravi" "$staging/var/log/ravi" "$staging/run/ravi" "$staging/run/ravi-bootstrap"
chown 62000:62000 "$staging/var/lib/ravi" "$staging/srv/ravi" "$staging/var/log/ravi" "$staging/run/ravi"
chmod 0700 "$staging/var/lib/ravi"

# Keep rebuilds idempotent when the supplied base already contains an older
# appliance layer.
sed -i \
  -e '\|^LABEL=RAVI_STATE /var/lib/ravi |d' \
  -e '\|^LABEL=RAVI_BOOTSTRAP /run/ravi-bootstrap |d' \
  -e '\|^/var/lib/ravi/workspaces /srv/ravi |d' \
  -e '\|^/var/lib/ravi/logs /var/log/ravi |d' \
  "$staging/etc/fstab"
cat >>"$staging/etc/fstab" <<'EOF'
LABEL=RAVI_STATE /var/lib/ravi ext4 defaults,nosuid,nodev,nofail,x-systemd.device-timeout=15s 0 2
LABEL=RAVI_BOOTSTRAP /run/ravi-bootstrap ext4 rw,nosuid,nodev,noexec,nofail,x-systemd.device-timeout=15s 0 2
/var/lib/ravi/workspaces /srv/ravi none bind,nofail,x-systemd.requires-mounts-for=/var/lib/ravi 0 0
/var/lib/ravi/logs /var/log/ravi none bind,nofail,x-systemd.requires-mounts-for=/var/lib/ravi 0 0
EOF

cat >"$staging/etc/ravi-appliance/runtime.env" <<'EOF'
HOME=/var/lib/ravi
RAVI_STATE_DIR=/var/lib/ravi/.ravi
NATS_URL=nats://127.0.0.1:4222
RAVI_HTTP_HOST=0.0.0.0
RAVI_HTTP_PORT=4211
RAVI_GATEWAY_NETWORK_AUTHORIZED=1
RAVI_SDK_GATEWAY_ALLOW_SUPERADMIN=0
RAVI_LOG_LEVEL=info
CODEX_HOME=/var/lib/ravi/.codex
EOF

cat >"$staging/etc/systemd/system/ravi-appliance-network.service" <<'EOF'
[Unit]
Description=Managed Ravi Firecracker outbound network
After=local-fs.target
Before=ravi-appliance-firstboot.service network-online.target

[Service]
Type=oneshot
Environment=RAVI_NETWORK_INTERFACE=eth0
Environment=RAVI_DNS_SERVERS=1.1.1.1,9.9.9.9
ExecStart=/usr/bin/python3 /usr/lib/ravi-appliance/network.py
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat >"$staging/etc/systemd/system/ravi-appliance-firstboot.service" <<'EOF'
[Unit]
Description=Managed Ravi appliance first boot
Before=ravi-appliance-nats.service ravi-appliance.service
Requires=ravi-appliance-network.service
After=local-fs.target ravi-appliance-network.service
RequiresMountsFor=/var/lib/ravi /run/ravi-bootstrap

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/lib/ravi-appliance/firstboot.py
RemainAfterExit=yes
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

cat >"$staging/etc/systemd/system/ravi-appliance-nats.service" <<'EOF'
[Unit]
Description=Managed Ravi local NATS JetStream
Requires=ravi-appliance-firstboot.service
After=ravi-appliance-firstboot.service network.target

[Service]
Type=simple
User=ravi
Group=ravi
ExecStart=/usr/local/bin/nats-server -js -sd /var/lib/ravi/jetstream -a 127.0.0.1 -p 4222
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/ravi/jetstream /var/log/ravi /run/ravi

[Install]
WantedBy=multi-user.target
EOF

cat >"$staging/etc/systemd/system/ravi-appliance.service" <<'EOF'
[Unit]
Description=Managed Ravi daemon
Requires=ravi-appliance-firstboot.service ravi-appliance-nats.service
After=ravi-appliance-firstboot.service ravi-appliance-nats.service network-online.target

[Service]
Type=simple
User=ravi
Group=ravi
EnvironmentFile=/etc/ravi-appliance/runtime.env
WorkingDirectory=/srv/ravi/agents/managed-ravi
ExecStart=/opt/ravi/current/bin/ravi daemon run
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/ravi /srv/ravi /var/log/ravi /run/ravi
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat >"$staging/etc/systemd/system/ravi-appliance-readiness.service" <<'EOF'
[Unit]
Description=Managed Ravi appliance readiness
Requires=ravi-appliance.service
After=ravi-appliance.service

[Service]
Type=oneshot
EnvironmentFile=/etc/ravi-appliance/runtime.env
ExecStartPre=/usr/bin/sleep 3
ExecStart=/usr/bin/python3 /usr/lib/ravi-appliance/readiness.py
TimeoutStartSec=75
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

cat >"$staging/etc/systemd/system/ravi-appliance-ready-gate.service" <<'EOF'
[Unit]
Description=Managed Ravi private readiness gate
Requires=ravi-appliance.service
After=ravi-appliance.service

[Service]
Type=simple
User=ravi
Group=ravi
ExecStart=/usr/bin/python3 /usr/lib/ravi-appliance/ready_gate.py
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/ravi/.ravi /var/lib/ravi/provisioning
RestrictAddressFamilies=AF_INET

[Install]
WantedBy=multi-user.target
EOF

for unit in ravi-appliance-network ravi-appliance-firstboot ravi-appliance-nats ravi-appliance ravi-appliance-readiness ravi-appliance-ready-gate; do
  mkdir -p "$staging/etc/systemd/system/multi-user.target.wants"
  ln -sfn "../${unit}.service" "$staging/etc/systemd/system/multi-user.target.wants/${unit}.service"
done

# Golden-image hygiene: identity and all mutable/auth state must be absent.
: >"$staging/etc/machine-id"
rm -f "$staging/var/lib/dbus/machine-id" "$staging"/etc/ssh/ssh_host_* "$staging/root/.ssh/authorized_keys"
rm -rf "$staging/root/.codex" "$staging/root/.ravi" "$staging/home"/*/.codex "$staging/home"/*/.ravi \
  "$staging/var/lib/ravi"/* "$staging/srv/ravi"/* "$staging/var/log/ravi"/* "$staging/run/ravi"/* "$staging/run/ravi-bootstrap"/*
find "$staging" -xdev \( -name '*.log' -o -name '*.pid' -o -name 'ravi.db*' -o -name 'credentials.json' \) -type f -delete

python3 "$script_dir/hygiene.py" "$staging" >"$output_dir/hygiene.json"

rm -f "$rootfs"
truncate -s "${size_mib}M" "$rootfs"
mkfs.ext4 -q -d "$staging" -L RAVI_ROOT -F "$rootfs"
e2fsck -fn "$rootfs" >/dev/null

kernel_sha=$(sha256sum "${ARG[kernel]}" | awk '{print $1}')
rootfs_sha=$(sha256sum "$rootfs" | awk '{print $1}')
ravi_release_sha=$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -C "${ARG[ravi_release]}" -cf - . | sha256sum | awk '{print $1}')
contract_sha=$(sha256sum "${ARG[contract]}" | awk '{print $1}')
cat >"$manifest" <<EOF
{
  "schemaVersion": "ravi.managed-appliance.image/v1",
  "name": "${ARG[name]}",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "architecture": "x86_64",
  "kernel": {"path": "$(basename "${ARG[kernel]}")", "sha256": "$kernel_sha"},
  "rootfs": {"path": "$(basename "$rootfs")", "sha256": "$rootfs_sha", "sizeMib": $size_mib},
  "ravi": {"version": "${ARG[ravi_version]}", "revision": "${ARG[ravi_revision]}", "releaseSha256": "$ravi_release_sha"},
  "bun": {"version": "${ARG[bun_version]}"},
  "nats": {"version": "${ARG[nats_version]}"},
  "codex": {"version": "${ARG[codex_version]}"},
  "bootstrapPublicKeySha256": "$(sha256sum "${ARG[bootstrap_public_key]}" | awk '{print $1}')",
  "contractSha256": "$contract_sha",
  "hygiene": {"passed": true, "report": "hygiene.json"},
  "provenance": "provenance.json",
  "sbom": "sbom.spdx.json"
}
EOF
chmod 0644 "$manifest" "$output_dir/hygiene.json"
python3 "$script_dir/image_metadata.py" emit \
  --contract "${ARG[contract]}" --name "${ARG[name]}" \
  --bootstrap-public-key "${ARG[bootstrap_public_key]}" \
  --ravi-version "${ARG[ravi_version]}" --ravi-revision "${ARG[ravi_revision]}" \
  --codex-version "${ARG[codex_version]}" --bun-version "${ARG[bun_version]}" --nats-version "${ARG[nats_version]}" \
  --kernel "${ARG[kernel]}" --rootfs "$rootfs" --base-squashfs "${ARG[base_squashfs]}" \
  --ravi-release-sha256 "$ravi_release_sha" --output-dir "$output_dir" >/dev/null
echo "$manifest"

#!/usr/bin/env bash
# P0A validation launcher only. Customer-shaped execution must use Deck+jailer in P0B.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: launch-firecracker-lab.sh \
  --name NAME --kernel PATH --rootfs PATH --state PATH --bootstrap PATH \
  --tap TAP --host-ip IP --guest-mac MAC --runtime-dir PATH
EOF
}

declare -A ARG=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name|--kernel|--rootfs|--state|--bootstrap|--tap|--host-ip|--guest-mac|--runtime-dir)
      ARG["${1#--}"]="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
for key in name kernel rootfs state bootstrap tap host-ip guest-mac runtime-dir; do
  [[ -n ${ARG[$key]:-} ]] || { echo "Missing --$key" >&2; exit 2; }
done
for key in kernel rootfs state bootstrap; do
  [[ -f ${ARG[$key]} ]] || { echo "Missing file: ${ARG[$key]}" >&2; exit 2; }
done

runtime_dir=$(realpath -m "${ARG[runtime-dir]}")
mkdir -p "$runtime_dir"
socket="$runtime_dir/firecracker.socket"
log="$runtime_dir/firecracker.log"
pidfile="$runtime_dir/firecracker.pid"
rm -f "$socket" "$pidfile"

sudo ip link del "${ARG[tap]}" 2>/dev/null || true
sudo ip tuntap add dev "${ARG[tap]}" mode tap user "$(id -un)"
sudo ip addr add "${ARG[host-ip]}/30" dev "${ARG[tap]}"
sudo ip link set dev "${ARG[tap]}" up
sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null
default_iface=$(ip route show default | awk '/default/ {for (i=1; i<=NF; i++) if ($i == "dev") {print $(i+1); exit}}')
if [[ -n "$default_iface" ]] && ! sudo iptables -t nat -C POSTROUTING -o "$default_iface" -j MASQUERADE 2>/dev/null; then
  sudo iptables -t nat -A POSTROUTING -o "$default_iface" -j MASQUERADE
fi
for rule in "-i ${ARG[tap]}" "-o ${ARG[tap]}"; do
  read -r direction device <<<"$rule"
  if ! sudo iptables -C FORWARD "$direction" "$device" -j ACCEPT 2>/dev/null; then
    sudo iptables -A FORWARD "$direction" "$device" -j ACCEPT
  fi
done

firecracker --id "${ARG[name]}" --api-sock "$socket" --log-path "$log" --level Info </dev/null >>"$log" 2>&1 &
pid=$!
echo "$pid" >"$pidfile"
for _ in $(seq 1 50); do
  [[ -S "$socket" ]] && break
  kill -0 "$pid" 2>/dev/null || { tail -n 80 "$log" >&2; exit 1; }
  sleep 0.1
done
[[ -S "$socket" ]] || { echo "Firecracker socket did not become ready" >&2; exit 1; }

put() {
  local path=$1 payload=$2
  curl -fsS -X PUT --unix-socket "$socket" -H 'content-type: application/json' --data "$payload" "http://localhost$path"
}

put /machine-config '{"vcpu_count":2,"mem_size_mib":4096,"track_dirty_pages":false}'
put /boot-source "{\"kernel_image_path\":\"${ARG[kernel]}\",\"boot_args\":\"console=ttyS0 reboot=k panic=1 pci=off\"}"
put /drives/rootfs "{\"drive_id\":\"rootfs\",\"path_on_host\":\"${ARG[rootfs]}\",\"is_root_device\":true,\"is_read_only\":false}"
put /drives/state "{\"drive_id\":\"state\",\"path_on_host\":\"${ARG[state]}\",\"is_root_device\":false,\"is_read_only\":false}"
put /drives/bootstrap "{\"drive_id\":\"bootstrap\",\"path_on_host\":\"${ARG[bootstrap]}\",\"is_root_device\":false,\"is_read_only\":false}"
put /network-interfaces/net1 "{\"iface_id\":\"net1\",\"guest_mac\":\"${ARG[guest-mac]}\",\"host_dev_name\":\"${ARG[tap]}\"}"
put /actions '{"action_type":"InstanceStart"}'

printf '{"name":"%s","pid":%s,"socket":"%s","log":"%s","tap":"%s"}\n' \
  "${ARG[name]}" "$pid" "$socket" "$log" "${ARG[tap]}"

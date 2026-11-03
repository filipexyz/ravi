import { FleetError } from "./contract";

export function sshPortPolicy(env: Record<string, string | undefined> = process.env): readonly number[] {
  const raw = env.RAVI_FLEET_SSH_ALLOWED_PORTS ?? "22";
  if (!/^\d{1,5}(,\d{1,5}){0,15}$/.test(raw)) throw new FleetError("ssh_port_policy_invalid", 503);
  const ports = raw.split(",").map(Number);
  validateSshPorts(ports);
  return Object.freeze(ports);
}
export function validateSshPorts(ports: readonly number[]) {
  if (!ports.length || ports.length > 16 || new Set(ports).size !== ports.length ||
    ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new FleetError("ssh_port_policy_invalid", 503);
}
export function assertSshPort(port: number, ports: readonly number[] = [22]) {
  validateSshPorts(ports);
  if (!ports.includes(port)) throw new FleetError("ssh_port_not_allowed", 403);
}

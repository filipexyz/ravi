// The host-owned cloudflared configuration of a locally managed tunnel and
// the drift comparison against what cloudflared reports on its loopback
// `/config`. Console `sandbox-gateway/listener` SPEC §Host And cloudflared,
// §Drift Check; `tunnels` SPEC §Host-Pinned Reach.
//
// Template, exactly:
//   ingress[0]: hostname <installationId>.<TUNNEL_ZONE> → http://127.0.0.1:<servicePort>
//               originRequest.access { required: true, teamName, audTag: [accessAud] }
//   ingress[1]: http_status:404 (catch-all)
//   warp-routing.enabled: false
// No credentials in the file: cloudflared reads them from TUNNEL_CRED_CONTENTS.

export interface TunnelIngressTemplate {
  tunnelId: string;
  hostname: string;
  servicePort: number;
  /** First DNS label of `accessTeamDomain`. */
  teamName: string;
  accessAud: string;
}

export const LOOPBACK = "127.0.0.1";

export function accessTeamName(accessTeamDomain: string): string {
  return accessTeamDomain.split(".")[0] ?? "";
}

export function originService(servicePort: number): string {
  return `http://${LOOPBACK}:${servicePort}`;
}

/** YAML with every scalar JSON-quoted, so no value can change the document's structure. */
export function renderCloudflaredConfig(template: TunnelIngressTemplate): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "# Written by `ravi gateway tunnel-run`; regenerated on every start. Do not edit.",
    `tunnel: ${q(template.tunnelId)}`,
    "ingress:",
    `  - hostname: ${q(template.hostname)}`,
    `    service: ${q(originService(template.servicePort))}`,
    "    originRequest:",
    "      access:",
    "        required: true",
    `        teamName: ${q(template.teamName)}`,
    "        audTag:",
    `          - ${q(template.accessAud)}`,
    `  - service: ${q("http_status:404")}`,
    "warp-routing:",
    "  enabled: false",
    "",
  ].join("\n");
}

/**
 * `cloudflared tunnel … run <id>`. The metrics server (which also serves
 * `/config`) is bound to loopback; anything else is refused here.
 */
export function buildCloudflaredArgs(input: { configPath: string; metricsPort: number; tunnelId: string }): string[] {
  if (!Number.isInteger(input.metricsPort) || input.metricsPort < 1 || input.metricsPort > 65535) {
    throw new Error(`Invalid cloudflared metrics port: ${input.metricsPort}`);
  }
  return [
    "tunnel",
    "--no-autoupdate",
    // A stop must finish inside PM2's kill timeout, or a SIGKILLed runner leaves cloudflared behind.
    "--grace-period",
    "1s",
    "--config",
    input.configPath,
    "--metrics",
    `${LOOPBACK}:${input.metricsPort}`,
    "run",
    input.tunnelId,
  ];
}

export type DriftReason =
  | "config_version"
  | "config_unparseable"
  | "ingress_mismatch"
  | "warp_routing"
  | "poll_failed"
  | "poll_stale"
  | "metrics_socket_owner";

export type ConfigCheck = { ok: true } | { ok: false; reason: DriftReason; detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const emptyish = (value: unknown) => value === undefined || value === null || value === "";

/**
 * Compares cloudflared's `GET /config` body (`{version, config: {ingress,
 * warp-routing, originRequest}}`) with the template. Any remote version
 * (≠ -1), any extra/missing/changed rule, a path matcher, a weakened Access
 * requirement or warp-routing on is drift.
 */
export function checkRemoteConfig(body: unknown, template: TunnelIngressTemplate): ConfigCheck {
  if (!isRecord(body) || !isRecord(body.config)) {
    return { ok: false, reason: "config_unparseable", detail: "no config object" };
  }
  if (body.version !== -1) {
    return { ok: false, reason: "config_version", detail: `version ${JSON.stringify(body.version)}` };
  }
  const { ingress } = body.config;
  if (!Array.isArray(ingress) || ingress.length !== 2) {
    return {
      ok: false,
      reason: "ingress_mismatch",
      detail: `ingress has ${Array.isArray(ingress) ? ingress.length : "no"} rules`,
    };
  }
  const [first, last] = ingress as unknown[];
  if (!isRecord(first) || !isRecord(last)) {
    return { ok: false, reason: "ingress_mismatch", detail: "rule is not an object" };
  }
  if (String(first.hostname ?? "").toLowerCase() !== template.hostname) {
    return { ok: false, reason: "ingress_mismatch", detail: "rule 0 hostname" };
  }
  if (first.service !== originService(template.servicePort)) {
    return { ok: false, reason: "ingress_mismatch", detail: "rule 0 service" };
  }
  if (!emptyish(first.path)) return { ok: false, reason: "ingress_mismatch", detail: "rule 0 path" };
  const access = isRecord(first.originRequest) ? first.originRequest.access : undefined;
  if (
    !isRecord(access) ||
    access.required !== true ||
    access.teamName !== template.teamName ||
    !Array.isArray(access.audTag) ||
    access.audTag.length !== 1 ||
    access.audTag[0] !== template.accessAud
  ) {
    return { ok: false, reason: "ingress_mismatch", detail: "rule 0 originRequest.access" };
  }
  if (!(emptyish(last.hostname) || last.hostname === "*") || !emptyish(last.path)) {
    return { ok: false, reason: "ingress_mismatch", detail: "rule 1 matcher" };
  }
  if (last.service !== "http_status:404") {
    return { ok: false, reason: "ingress_mismatch", detail: "rule 1 service" };
  }
  const warp = body.config["warp-routing"];
  if (isRecord(warp) && warp.enabled === true) {
    return { ok: false, reason: "warp_routing", detail: "warp-routing enabled" };
  }
  return { ok: true };
}

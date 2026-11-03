import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const buildScript = readFileSync(join(import.meta.dir, "build-rootfs.sh"), "utf8");

describe("Managed Ravi rootfs build", () => {
  test("keeps package test modules that generated SDKs may import at runtime", () => {
    expect(buildScript).not.toContain("-name test -o -name tests");
    expect(buildScript).not.toContain("-name '*.md'");
  });

  test("normalizes immutable Ravi and Codex releases to root ownership", () => {
    expect(buildScript).toContain('chown -R 0:0 "$release_dir" "$staging/opt/codex"');
  });

  test("replaces immutable runtime layers when rebuilding from an appliance base", () => {
    const prune =
      'rm -rf "$staging/opt/ravi/releases" "$staging/opt/ravi/current" "$staging/opt/codex"';

    expect(buildScript).toContain(prune);
    expect(buildScript.indexOf(prune)).toBeLessThan(buildScript.indexOf('cp -a "${ARG[ravi_release]}/."'));
  });

  test("starts a deterministic outbound network before first boot", () => {
    expect(buildScript).toContain("ravi-appliance-network.service");
    expect(buildScript).toContain("Requires=ravi-appliance-network.service");
    expect(buildScript).toContain("RAVI_STATE_DIR=/var/lib/ravi/.ravi");
    expect(buildScript).toContain("RAVI_HTTP_HOST=0.0.0.0");
    expect(buildScript).toContain("RAVI_GATEWAY_NETWORK_AUTHORIZED=1");
  });

  test("exposes the SDK gateway only through the microVM private network policy", () => {
    expect(buildScript).not.toContain("RAVI_HTTP_HOST=127.0.0.1");
    expect(buildScript).toContain("RAVI_SDK_GATEWAY_ALLOW_SUPERADMIN=0");
  });

  test("opens a fail-closed private diagnostic gate while readiness is evaluated", () => {
    expect(buildScript).toContain('install -m 0755 "$script_dir/ready_gate.py"');
    expect(buildScript).toContain("ravi-appliance-ready-gate.service");
    expect(buildScript).toContain("TimeoutStartSec=75");
    expect(buildScript).toContain("Requires=ravi-appliance.service");
    expect(buildScript).toContain("After=ravi-appliance.service");
    expect(buildScript).not.toContain("Requires=ravi-appliance-readiness.service");
    expect(buildScript).toContain("ReadWritePaths=/var/lib/ravi/.ravi /var/lib/ravi/provisioning");
    expect(buildScript).not.toContain("ReadWritePaths=/var/lib/ravi\n");
    expect(buildScript).toContain("RestrictAddressFamilies=AF_INET");
  });

  test("replaces managed fstab entries instead of duplicating them on rebuild", () => {
    expect(buildScript).toContain("^LABEL=RAVI_STATE /var/lib/ravi ");
    expect(buildScript).toContain("^LABEL=RAVI_BOOTSTRAP /run/ravi-bootstrap ");
    expect(buildScript).toContain("^/var/lib/ravi/workspaces /srv/ravi ");
    expect(buildScript).toContain("^/var/lib/ravi/logs /var/log/ravi ");
    expect(buildScript).toContain("RequiresMountsFor=/var/lib/ravi /run/ravi-bootstrap");
  });

  test("keeps validation Firecracker processes from consuming the caller stdin", () => {
    const launcher = readFileSync(join(import.meta.dir, "launch-firecracker-lab.sh"), "utf8");

    expect(launcher).toContain("</dev/null");
  });
});

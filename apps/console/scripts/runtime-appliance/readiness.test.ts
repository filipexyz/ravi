import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const readiness = join(import.meta.dir, "readiness.py");

describe("Managed Ravi appliance readiness", () => {
  test("measures bounded clock skew through the allowed HTTPS path", () => {
    const result = runClockProbe("Wed, 15 Jul 2026 18:00:01 GMT", [1_784_138_400, 1_784_138_402]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ntpSynchronized: false,
      ok: true,
      offsetSeconds: 0,
      source: "https://www.cloudflare.com/",
      epochSeconds: 1_784_138_402,
    });
    expect(result.stderr).toBe("");
  });

  test("fails closed when HTTPS time has excessive skew", () => {
    const result = runClockProbe("Wed, 15 Jul 2026 18:05:00 GMT", [1_784_138_400, 1_784_138_402]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(false);
  });

  test("falls back to HTTPS when timedatectl blocks on unavailable D-Bus", () => {
    const result = runClockProbe(
      "Wed, 15 Jul 2026 18:00:01 GMT",
      [1_784_138_400, 1_784_138_402],
      true,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ntpSynchronized: false,
      ok: true,
      source: "https://www.cloudflare.com/",
    });
    expect(result.stderr).toBe("");
  });

  test("does not open a UDP NTP path outside the appliance egress contract", async () => {
    const source = await Bun.file(readiness).text();

    expect(source).not.toContain("SOCK_DGRAM");
    expect(source).not.toContain("ntp_offset");
  });

  test("bounds resolver and subprocess checks and records atomic progress", async () => {
    const source = await Bun.file(readiness).text();

    expect(source).toContain('["getent", "ahostsv4", host]');
    expect(source).toContain("timeout=DNS_TIMEOUT_SECONDS");
    expect(source).toContain("timeout=timeout");
    expect(source).toContain('code="readiness_pending", current_check=name');
    expect(source).toContain('temporary.replace(READINESS_PATH)');
  });

  test("requires the keyless Codex config and a healthy host broker", () => {
    const result = runProviderProbe(true);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      configured: true,
      kind: "host_responses_proxy",
      ok: true,
    });
  });

  test("fails closed when the host broker cannot validate its provider credential", () => {
    const result = runProviderProbe(false);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ configured: true, ok: false });
  });
});

function runClockProbe(
  dateHeader: string,
  clockValues: [number, number],
  timedatectlTimeout = false,
) {
  const source = [
    "import importlib.util, json, sys",
    "from unittest import mock",
    "spec=importlib.util.spec_from_file_location('readiness', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "class Response:",
    " def __init__(self, value): self.headers={'Date': value}",
    " def __enter__(self): return self",
    " def __exit__(self, *args): return False",
    "synchronized=mock.Mock(returncode=0, stdout='no\\n')",
    "runner=mock.patch.object(module.subprocess, 'run', side_effect=module.subprocess.TimeoutExpired(cmd=['timedatectl'], timeout=module.CLOCK_COMMAND_TIMEOUT_SECONDS)) if sys.argv[5]=='1' else mock.patch.object(module.subprocess, 'run', return_value=synchronized)",
    "with runner, mock.patch.object(module.urllib.request, 'urlopen', return_value=Response(sys.argv[2])), mock.patch.object(module.time, 'time', side_effect=[float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[4])]):",
    " print(json.dumps(module.clock_check(), sort_keys=True))",
  ].join("\n");
  const result = Bun.spawnSync([
    "python3",
    "-c",
    source,
    readiness,
    dateHeader,
    String(clockValues[0]),
    String(clockValues[1]),
    timedatectlTimeout ? "1" : "0",
  ]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runProviderProbe(healthy: boolean) {
  const source = [
    "import importlib.util, json, pathlib, sys, tempfile",
    "from unittest import mock",
    "spec=importlib.util.spec_from_file_location('readiness', sys.argv[1])",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "class Response:",
    " status=200",
    " def __enter__(self): return self",
    " def __exit__(self, *args): return False",
    " def read(self, _size): return b'{\"ok\":true}'",
    "with tempfile.TemporaryDirectory() as root:",
    " state=pathlib.Path(root)/'provider.json'",
    " config=pathlib.Path(root)/'config.toml'",
    " state.write_text(json.dumps({'schemaVersion':'ravi.managed-appliance.provider-broker/v1','baseUrl':'http://172.30.0.1:7443/v1','healthUrl':'http://172.30.0.1:7443/health'}))",
    " config.write_text('base_url = \"http://172.30.0.1:7443/v1\"\\nrequires_openai_auth = false\\n')",
    " patcher=mock.patch.object(module.urllib.request, 'urlopen', return_value=Response()) if sys.argv[2]=='1' else mock.patch.object(module.urllib.request, 'urlopen', side_effect=OSError('unavailable'))",
    " with patcher:",
    "  print(json.dumps(module.provider_broker_check(state, config), sort_keys=True))",
  ].join("\n");
  const result = Bun.spawnSync([
    "python3",
    "-c",
    source,
    readiness,
    healthy ? "1" : "0",
  ]);
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}
